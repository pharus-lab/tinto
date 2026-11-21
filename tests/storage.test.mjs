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

test('deleting a source preserves its drafts as documents, including after a version restore', t => {
  const f = fixture(t)
  const draft = f.store.createDraft(f.doc.id, null, 'Rewrite')
  f.store.snapshot(draft.id, 'First draft')
  f.store.snapshot(f.doc.id, 'Original')
  f.store.save({ ...draft, title: 'Revised chapter' })
  f.store.deleteDocument(f.doc.id)
  f.reopen()
  const [remaining] = f.store.read().documents
  assert.equal(remaining.source, undefined)
  assert.deepEqual(f.store.versions(f.doc.id), [])
  const restored = f.store.restore(draft.id, f.store.versions(draft.id)[0].id)
  assert.deepEqual(restored, remaining)
  assert.equal(restored.title, 'Revised chapter')
})

test('moving a document preserves its history, handles ID collisions, and keeps drafts readable', t => {
  const f = fixture(t)
  const path = join(f.directory, 'Part #2.tinto')
  const destination = ProjectStore.create(path, 'Part two', f.doc)
  t.after(() => destination.close())
  const draft = f.store.createDraft(f.doc.id, null, 'Another ending')
  f.store.snapshot(f.doc.id, 'Before revision')
  f.store.snapshot(f.doc.id, null)
  const versions = f.store.versions(f.doc.id)
  assert.throws(() => f.store.moveDocument(f.doc.id, path), /already contains/)
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
  assert.deepEqual(f.store.versions(f.doc.id), versions)
  destination.deleteDocument(f.doc.id)
  const origin = f.store.moveDocument(f.doc.id, path)
  assert.deepEqual(destination.read().documents, [f.doc])
  assert.deepEqual(destination.versions(f.doc.id), versions)
  assert.deepEqual(f.store.versions(f.doc.id), [])
  const standalone = { ...draft }
  delete standalone.source
  assert.deepEqual(f.store.read().documents, [standalone])

  const revised = { ...f.doc, title: 'New title after moving' }
  destination.save(revised)
  standalone.manuscript.content[1].content[0].text = 'New draft wording.'
  f.store.save(standalone)
  destination.moveDocument(f.doc.id, f.path, origin)
  f.reopen()
  assert.deepEqual(f.store.read().documents, [revised, { ...standalone, source: draft.source }])
  assert.deepEqual(f.store.versions(f.doc.id), versions)
  assert.equal(f.store.reviewDraft(draft.id)[0].origin, 'draft')
  assert.deepEqual(destination.read().documents, [])

  f.store.moveDocument(f.doc.id, path)

  const secondDraft = destination.createDraft(f.doc.id, null, 'Shorter ending')
  const draftOrigin = destination.moveDocument(secondDraft.id, f.path)
  const movedDraft = f.store.read().documents[1]
  assert.equal(movedDraft.source, undefined)
  assert.deepEqual(movedDraft.manuscript, secondDraft.manuscript)
  assert.deepEqual(destination.read().documents, [revised])
  f.store.moveDocument(secondDraft.id, path, draftOrigin)
  assert.deepEqual(destination.read().documents, [revised, secondDraft])
  assert.deepEqual(destination.reviewDraft(secondDraft.id), [])
})

test('published post records move with their document and go when it is deleted', t => {
  const f = fixture(t)
  const post = {
    id: 'post-1', siteId: 'site-a', documentId: f.doc.id, headingId: null, title: 'The kitchen', slug: 'the-kitchen', summary: '', date: '2026-11-21', tags: [],
    language: 'en', status: 'published', category: '', cover: null, images: [], attachments: [], url: null, publishedAt: 1, release: null,
    credential: null, verified: false
  }
  f.store.savePost(post)
  const path = join(f.directory, 'Elsewhere.tinto')
  const destination = ProjectStore.create(path, 'Elsewhere')
  t.after(() => destination.close())
  const origin = f.store.moveDocument(f.doc.id, path)
  assert.deepEqual(f.store.posts(f.doc.id, null), [])
  assert.deepEqual(destination.posts(f.doc.id, null), [post])
  destination.moveDocument(f.doc.id, f.path, origin)
  assert.deepEqual(f.store.posts(f.doc.id, null), [post])
  assert.deepEqual(destination.posts(f.doc.id, null), [])
  f.store.deleteDocument(f.doc.id)
  assert.deepEqual(f.store.posts(f.doc.id, null), [])
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

test('a version 2 project gains per-website post records that survive restore, reopening and backup verification', t => {
  const f = fixture(t)
  const id = f.store.read().id
  const db = new DatabaseSync(f.path)
  db.exec('DROP TABLE posts; PRAGMA user_version = 2;')
  db.close()
  f.reopen()
  assert.equal(f.store.projectId(), id)
  const post = {
    id: 'post-1', siteId: 'site-a', documentId: f.doc.id, headingId: 'the-kitchen', title: 'The kitchen', slug: 'the-kitchen', summary: '', date: '2026-11-21', tags: [],
    language: 'en', cover: null, images: [], url: null, publishedAt: 1
  }
  const elsewhere = { ...post, id: 'post-2', siteId: 'site-b', url: 'https://example.org/the-kitchen' }
  // Records saved before drafts, categories, attachments and releases read back with defaults.
  const read = record => ({ status: 'published', category: '', attachments: [], release: null, credential: null, verified: false, ...record })
  f.store.snapshot(f.doc.id, 'Before publishing')
  f.store.savePost(post)
  f.store.savePost({ ...post, title: 'Updated' })
  f.store.savePost(elsewhere)
  f.store.restore(f.doc.id, f.store.versions(f.doc.id)[0].id)
  f.reopen()
  assert.deepEqual(f.store.post('site-a', f.doc.id, 'the-kitchen'), read({ ...post, title: 'Updated' }))
  assert.deepEqual(f.store.posts(f.doc.id, 'the-kitchen'), [read({ ...post, title: 'Updated' }), read(elsewhere)])
  assert.deepEqual(f.store.allPosts(), [read({ ...post, title: 'Updated' }), read(elsewhere)])
  assert.equal(f.store.post('site-a', f.doc.id, null), null)
  assert.throws(() => f.store.savePost({ ...post, id: 'post-3' }), /UNIQUE/)
  const copy = join(f.directory, 'copy.tinto')
  f.store.backupTo(copy)
  ProjectStore.verifyBackup(copy, id)
  f.store.deletePost(post.id)
  assert.equal(f.store.post('site-a', f.doc.id, 'the-kitchen'), null)
  assert.deepEqual(f.store.posts(f.doc.id, 'the-kitchen'), [read(elsewhere)])
})

test('a version 3 project from the single-site builds gets the per-website post table', t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.path)
  db.exec(`DROP TABLE posts;
    CREATE TABLE posts (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), heading_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, UNIQUE (document_id, heading_id));
    PRAGMA user_version = 3;`)
  db.close()
  f.reopen()
  const check = new DatabaseSync(f.path, { readOnly: true })
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5)
  assert.ok(check.prepare('PRAGMA table_info(posts)').all().some(column => column.name === 'site_id'))
  check.close()
  assert.equal(f.store.read().documents[0].id, f.doc.id)
  assert.deepEqual(f.store.posts(f.doc.id, null), [])
})

test('the writing record keeps counts only, chains every entry, travels with its document and shows any change', t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.path)
  db.exec('DROP TABLE authorship_log; PRAGMA user_version = 4;')
  db.close()
  f.reopen()
  const empty = f.store.writingEvidence(f.doc.id)
  assert.deepEqual([empty.entries, empty.heads, empty.intact], [0, [], true])
  f.store.recordWriting(f.doc.id, 'typing', { typed: 120, deleted: 8, activeMs: 90_000, intervals: [1, 2, 40, 50, 10, 3, 1, 0], text: 'never kept' })
  f.store.recordWriting(f.doc.id, 'paste', { characters: 42 })
  f.store.recordWriting(f.doc.id, 'import', { characters: 1000 })
  f.store.recordWriting(f.doc.id, 'typing', { typed: 0, deleted: 0 })
  f.store.recordWriting('missing-document', 'typing', { typed: 5 })
  f.store.snapshot(f.doc.id, 'Chapter one')
  // A draft's typing counts for the document it came from.
  const draft = f.store.createDraft(f.doc.id, null, 'Second pass')
  f.store.recordWriting(draft.id, 'typing', { typed: 30, deleted: 2, activeMs: 20_000, intervals: [0, 0, 10, 15, 4, 1, 0, 0] })
  const evidence = f.store.writingEvidence(f.doc.id)
  assert.deepEqual([evidence.typed, evidence.deleted, evidence.pasted, evidence.imported, evidence.activeMs, evidence.sessions, evidence.entries, evidence.intact],
    [150, 10, 42, 1000, 110_000, 2, 5, true])
  assert.deepEqual(evidence.intervals, [1, 2, 50, 65, 14, 4, 1, 0])
  assert.equal(evidence.heads.length, 2)
  const rows = new DatabaseSync(f.path, { readOnly: true }).prepare('SELECT kind, data FROM authorship_log WHERE document_id = ? ORDER BY seq').all(f.doc.id)
  assert.deepEqual(rows.map(row => row.kind), ['typing', 'paste', 'import', 'version'])
  assert.doesNotMatch(JSON.stringify(rows), /never kept/)

  // The chain moves with the document, unchanged, and leaves with it.
  const path = join(f.directory, 'Elsewhere.tinto')
  const destination = ProjectStore.create(path, 'Elsewhere')
  t.after(() => destination.close())
  f.store.moveDocument(draft.id, path)
  f.store.moveDocument(f.doc.id, path)
  assert.deepEqual(destination.writingEvidence(f.doc.id).heads.length, 1)
  assert.equal(destination.writingEvidence(f.doc.id).intact, true)
  assert.equal(destination.writingEvidence(draft.id).typed, 30)
  assert.equal(f.store.writingEvidence(f.doc.id).entries, 0)

  // Any change to a recorded entry breaks the chain.
  const tamper = new DatabaseSync(path)
  tamper.prepare("UPDATE authorship_log SET data = json_set(data, '$.characters', 0) WHERE kind = 'paste'").run()
  tamper.close()
  assert.equal(destination.writingEvidence(f.doc.id).intact, false)
  destination.deleteDocument(f.doc.id)
  assert.equal(new DatabaseSync(path, { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM authorship_log WHERE document_id = ?').get(f.doc.id).n, 0)
})

