import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const source = await build({ entryPoints: ['src/storage.ts', 'src/model.ts'], outdir: 'out', platform: 'node', format: 'esm', bundle: true, write: false })
const [storage, model] = await Promise.all(source.outputFiles.map(output => import('data:text/javascript;base64,' + Buffer.from(output.contents).toString('base64'))))
const { ProjectStore } = storage
const { sampleManuscript } = model
const minute = 60_000
const day = 24 * 60 * minute

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tinto-project-'))
  const path = join(directory, 'Manuscript.tinto')
  const doc = { id: 'manuscript', title: 'The long way home', language: 'en', manuscript: sampleManuscript() }
  const clock = { time: Date.UTC(2026, 0, 1) }
  const now = () => clock.time
  let store = ProjectStore.create(path, 'Stories', doc, now)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { doc, clock, directory, path, get store() { return store }, reopen() { store.close(); store = new ProjectStore(path, now) } }
}

test('one portable project preserves the active and hidden branches, language, and document order', t => {
  const f = fixture(t)
  const extra = { ...f.doc, id: 'story-2', title: 'Otro cuento', language: 'es' }
  f.store.save(extra)
  const changed = structuredClone(f.doc)
  const sentence = changed.manuscript.content[2].content[1]
  sentence.attrs.options[0].content[0].text = 'I would like some tea.'
  sentence.content[1].content[0].marks = [{ type: 'strong' }, { type: 'highlight' }]
  f.store.save(changed)
  assert.throws(() => ProjectStore.create(f.path, 'Overwrite', f.doc), { code: 'EEXIST' })
  const id = f.store.read().id
  f.reopen()
  assert.deepEqual(f.store.read(), { id, title: 'Stories', documents: [changed, extra] })
  assert.deepEqual(readdirSync(f.directory), ['Manuscript.tinto'])
})

test('snapshots run after five minutes of changed work, including idle time and a restart', t => {
  const f = fixture(t)
  f.clock.time += 10 * minute
  f.store.tick()
  assert.equal(f.store.versions(f.doc.id).length, 0)
  f.store.save({ ...f.doc, language: 'es' })
  f.clock.time += 4 * minute
  f.reopen()
  const changed = { ...f.doc, title: 'The return', language: 'es' }
  f.store.save(changed)
  assert.equal(f.store.versions(f.doc.id).length, 0)
  f.clock.time += minute
  f.store.tick()
  assert.equal(f.store.versions(f.doc.id).length, 1)
  f.store.save(changed)
  f.clock.time += 5 * minute
  f.store.tick()
  assert.equal(f.store.versions(f.doc.id).length, 1)
})

test('restore recovers hidden options and preserves the later state; named history survives the 30-day cutoff', t => {
  const f = fixture(t)
  f.store.snapshot(f.doc.id, 'Opening draft')
  const [named] = f.store.versions(f.doc.id)
  const changed = structuredClone(f.doc)
  const outer = changed.manuscript.content[2].content[1]
  outer.attrs.options[0].content[0].text = 'A hidden replacement.'
  outer.content[1].content = [{ type: 'text', text: 'a pear' }]
  changed.language = 'es'
  f.store.save(changed)
  assert.deepEqual(f.store.restore(f.doc.id, named.id), f.doc)
  f.reopen()
  assert.deepEqual(f.store.read().documents[0], f.doc)
  const [beforeRestore] = f.store.versions(f.doc.id)
  assert.deepEqual(beforeRestore.manuscript, changed.manuscript)
  assert.equal(beforeRestore.language, 'es')
  const other = { ...f.doc, id: 'separate-document' }
  f.store.save(other)
  assert.throws(() => f.store.restore(other.id, named.id), /no longer available/)
  assert.equal(f.store.versions(other.id).length, 0)
  f.clock.time += 30 * day
  f.store.tick()
  assert.ok(f.store.versions(f.doc.id).some(version => version.id === beforeRestore.id))
  f.clock.time++
  f.store.tick()
  assert.ok(!f.store.versions(f.doc.id).some(version => version.id === beforeRestore.id))
  assert.ok(f.store.versions(f.doc.id).some(version => version.id === named.id))
  f.store.deleteVersion(f.doc.id, named.id)
  assert.ok(!f.store.versions(f.doc.id).some(version => version.id === named.id))
})

test('a version 2 project gains post records that survive restore, reopening and backup verification', t => {
  const f = fixture(t)
  const id = f.store.read().id
  const db = new DatabaseSync(f.path)
  db.exec('DROP TABLE posts; PRAGMA user_version = 2;')
  db.close()
  f.reopen()
  const post = {
    id: 'post-1', documentId: f.doc.id, headingId: 'the-kitchen', title: 'The kitchen', slug: 'the-kitchen', summary: '', date: '2026-11-20', tags: [],
    locale: 'en', cover: null, images: [], obsolete: [], publishedAt: 1, deployPending: false, removed: false
  }
  f.store.snapshot(f.doc.id, 'Before publishing')
  f.store.savePost(post)
  f.store.savePost({ ...post, title: 'Updated' })
  f.store.restore(f.doc.id, f.store.versions(f.doc.id)[0].id)
  f.reopen()
  assert.deepEqual(f.store.post(f.doc.id, 'the-kitchen'), { ...post, title: 'Updated' })
  assert.equal(f.store.post(f.doc.id, null), null)
  const copy = join(f.directory, 'copy.tinto')
  f.store.backupTo(copy)
  ProjectStore.verifyBackup(copy, id)
  f.store.deletePost(post.id)
  assert.equal(f.store.post(f.doc.id, 'the-kitchen'), null)
})
