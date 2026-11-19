import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './src/drive'; export * from './src/storage'; export * from './src/model'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { DriveBackups, GoogleDrive, ProjectStore, sampleManuscript } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

class TestDrive {
  blobs = new Map()
  items = []
  time = 0
  async upload(path, item) {
    if (this.fail) throw Error('Upload interrupted')
    const bytes = await readFile(path)
    assert.equal(sha256(bytes), item.checksum)
    const file = { ...item, id: String(++this.time), time: this.time }
    this.items.unshift(file)
    this.blobs.set(file.id, bytes)
    return file
  }
  async list() { return this.items }
  async trash(id) {
    if (this.failPrune) throw Error('Prune interrupted')
    this.items = this.items.filter(file => file.id !== id)
    this.blobs.delete(id)
  }
  async download(id, path) { await writeFile(path, this.blobs.get(id)) }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-drive-'))
  const document = { id: 'original', title: 'The kitchen', manuscript: sampleManuscript(), language: 'es' }
  const path = join(dir, 'local.tinto')
  const store = ProjectStore.create(path, 'Stories', document)
  const remote = new TestDrive()
  const backups = new DriveBackups(dir, remote)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, path, store, remote, backups, document }
}

test('five verified backups survive upload failure; skipped backups and pruning retry survive restart', async t => {
  const { store, remote, backups, document, dir } = await fixture(t)
  for (let i = 0; i < 5; i++) await backups.backup(store)
  const five = remote.items.slice()
  const id = store.read().id
  assert.equal(backups.lastSuccess(id), 5)
  assert.equal(await backups.backup(store, true), false)
  document.language = 'fr'
  store.save(document)
  remote.fail = true
  await assert.rejects(backups.backup(store, true), /Upload interrupted/)
  assert.deepEqual(remote.items, five)
  assert.equal(backups.lastSuccess(id), 5)
  remote.fail = false
  remote.failPrune = true
  await assert.rejects(backups.backup(store, true), /Prune interrupted/)
  assert.equal(remote.items.length, 6)
  const reopened = new DriveBackups(dir, remote)
  assert.equal(reopened.lastSuccess(id), 6)
  remote.failPrune = false
  assert.equal(await reopened.backup(store, true), false)
  assert.deepEqual(remote.items.map(item => item.time), [6, 5, 4, 3, 2])
})

test('a restored SQLite backup contains the complete draft, pending review, hidden wording, languages and retained versions', async t => {
  const { dir, store, remote, backups, document } = await fixture(t)
  const draft = store.createDraft(document.id, 'the-kitchen', 'A different kitchen')
  draft.language = 'fr'
  draft.manuscript.content[2].content[1].attrs.options[0].content[0].text = 'Another hidden sentence.'
  store.save(draft)
  store.snapshot(draft.id, 'Draft before review')
  store.snapshot(document.id, 'Source before review')
  const pending = store.reviewDraft(draft.id)
  assert.equal(pending.length, 1)
  const before = store.read()
  await backups.backup(store)
  const file = remote.items[0]
  const destination = join(dir, 'restored.tinto')
  const otherComputer = new DriveBackups(join(dir, 'second-profile'), remote)
  assert.deepEqual(await otherComputer.list(), [file])
  await otherComputer.restore(file.id, destination)
  const restored = new ProjectStore(destination)
  try {
    assert.deepEqual(restored.read(), before)
    assert.deepEqual(restored.reviewDraft(draft.id), pending)
    for (const doc of [draft, document]) assert.deepEqual(restored.versions(doc.id), store.versions(doc.id))
  } finally { restored.close() }
  const existing = await readFile(destination)
  await assert.rejects(otherComputer.restore(file.id, destination), { code: 'EEXIST' })
  assert.deepEqual(await readFile(destination), existing)
  remote.blobs.set(file.id, Buffer.from('truncated download'))
  const corrupt = join(dir, 'corrupt.tinto')
  await assert.rejects(otherComputer.restore(file.id, corrupt), /checksum/)
  await assert.rejects(readFile(corrupt), { code: 'ENOENT' })
})

test('Google Drive transport creates a visible folder and verifies the completed upload before accepting it', async t => {
  const { path } = await fixture(t)
  const bytes = await readFile(path)
  const item = { name: 'Manuscript.tinto', projectId: 'collection', checksum: sha256(bytes) }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (address, request) => {
    const url = new URL(address)
    assert.equal(request.headers.get('Authorization'), 'Bearer test-token')
    requests.push(url)
    if (!request.method) return Response.json({ files: [] })
    if (request.method === 'POST') {
      const payload = JSON.parse(request.body)
      if (!url.pathname.startsWith('/upload/')) {
        assert.equal(payload.mimeType, 'application/vnd.google-apps.folder')
        assert.equal(payload.name, 'Tinto Backups')
        return Response.json({ id: 'visible-folder' })
      }
      assert.deepEqual(payload.parents, ['visible-folder'])
      assert.equal(payload.appProperties.checksum, item.checksum)
      return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } })
    }
    assert.equal(request.method, 'PUT')
    assert.equal(sha256(Buffer.from(await request.body.arrayBuffer())), item.checksum)
    return Response.json({ id: 'remote', name: item.name, sha256Checksum: item.checksum, createdTime: new Date(1000).toISOString(), appProperties: { tintoType: 'project', projectId: item.projectId, checksum: item.checksum } })
  })
  const drive = new GoogleDrive(async () => 'test-token')
  assert.deepEqual(await drive.upload(path, item), { ...item, id: 'remote', time: 1000 })
  assert.equal(requests.length, 4)
})
