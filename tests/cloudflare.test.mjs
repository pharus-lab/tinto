import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './src/cloudflare'; export * from './src/publishing'; export * from './src/storage'; export * from './src/model'; export { postHTML } from './src/exchange'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { CloudflareSite, Publisher, ProjectStore, postHTML, sampleManuscript, validateConfig, verifySite, POSTS_TABLE } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const hook = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10'
const config = { accountId: '0123456789abcdef0123456789abcdef', databaseId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', bucket: 'site-media', token: 'test-token-with-enough-characters', deployHook: hook }
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cover pixels')])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('gallery pixels')])
const envelope = (result, init) => Response.json({ success: true, errors: [], messages: [], result }, init)
const failure = (status, errors = []) => Response.json({ success: false, errors, messages: [], result: null }, { status })

test('site settings accept only complete Cloudflare identifiers and a Workers Builds hook URL', () => {
  assert.deepEqual(validateConfig({ ...config, accountId: ' ' + config.accountId.toUpperCase() + ' ' }), config)
  const rejected = {
    accountId: 'my-account', databaseId: 'site-db', bucket: 'Site_Media', token: 'short',
    deployHook: 'https://hooks.example.com/client/v4/workers/builds/deploy_hooks/6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10'
  }
  for (const [field, value] of Object.entries(rejected)) assert.throws(() => validateConfig({ ...config, [field]: value }), Error, field)
  for (const deployHook of ['http://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/6f1c2a8e', hook + '?redirect=https://example.com', 'https://api.cloudflare.com/client/v4/accounts/x/d1/database', 'not a url']) {
    assert.throws(() => validateConfig({ ...config, deployHook }), /Deploy Hook URL/)
  }
})

test('D1 and R2 calls carry the token; the deploy hook URL is sent without it', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (address, request) => {
    requests.push({ url: String(address), method: request.method, auth: request.headers.get('Authorization'), type: request.headers.get('Content-Type'), body: request.body })
    if (String(address).endsWith('/query')) return envelope([{ success: true, results: [{ ok: 1 }], meta: {} }])
    if (request.method === 'PUT') return envelope({ key: 'k', size: String(request.body.byteLength) })
    if (request.method === 'DELETE') return failure(404)
    return envelope({ build_uuid: 'build', status: 'queued' })
  })
  const site = new CloudflareSite(config)
  assert.deepEqual(await site.query('SELECT 1 AS ok', ['a']), [{ ok: 1 }])
  await site.putObject('posts/abc/one two.png', png, 'image/png')
  await site.deleteObject('posts/abc/missing.png')
  await site.triggerDeploy()
  const account = 'https://api.cloudflare.com/client/v4/accounts/' + config.accountId
  assert.deepEqual(requests.map(({ url, method, auth }) => [url, method, auth]), [
    [account + '/d1/database/' + config.databaseId + '/query', 'POST', 'Bearer ' + config.token],
    [account + '/r2/buckets/site-media/objects/posts/abc/one%20two.png', 'PUT', 'Bearer ' + config.token],
    [account + '/r2/buckets/site-media/objects/posts/abc/missing.png', 'DELETE', 'Bearer ' + config.token],
    [hook, 'POST', null]
  ])
  assert.deepEqual(JSON.parse(requests[0].body), { sql: 'SELECT 1 AS ok', params: ['a'] })
  assert.equal(requests[1].type, 'image/png')
  assert.deepEqual(Buffer.from(requests[1].body), png)
  assert.equal(requests[3].body, undefined)
})

test('Cloudflare failures explain the missing permission or conflict', async t => {
  let reply
  t.mock.method(globalThis, 'fetch', async () => reply())
  const site = new CloudflareSite(config)
  reply = () => failure(403, [{ code: 10000, message: 'Authentication error' }])
  await assert.rejects(site.putObject('posts/a/b.png', png, 'image/png'), /cannot write to the R2 bucket “site-media”.*Bucket Item Write/)
  await assert.rejects(site.query('SELECT 1'), /D1 Edit/)
  reply = () => failure(400, [{ code: 7500, message: 'UNIQUE constraint failed: tinto_posts.slug, tinto_posts.locale: SQLITE_CONSTRAINT' }])
  await assert.rejects(site.query('INSERT'), /already uses this address/)
  reply = () => failure(429)
  await assert.rejects(site.triggerDeploy(), /10 deploy hook builds per minute/)
  reply = () => failure(404)
  await assert.rejects(site.triggerDeploy(), /Create a new hook/)
  reply = () => envelope({ key: 'k', size: '3' })
  await assert.rejects(site.putObject('posts/a/b.png', png, 'image/png'), /incomplete copy/)
  reply = () => { throw TypeError('fetch failed') }
  await assert.rejects(site.query('SELECT 1'), /could not be reached/)
})

test('a connection check writes the table and a disposable object but never starts a build', async () => {
  const calls = []
  await verifySite({
    query: async sql => { calls.push(sql === POSTS_TABLE ? 'table' : sql) },
    putObject: async key => { calls.push('put ' + key.split('/')[0]) },
    deleteObject: async key => { calls.push('delete ' + key.split('/')[0]) },
    triggerDeploy: async () => { calls.push('hook') }
  })
  assert.deepEqual(calls, ['table', 'put tinto-connection-check', 'delete tinto-connection-check'])
})

test('post HTML carries only the chosen wording with escaped text and author marks', () => {
  const blocks = sampleManuscript().content.slice(1, 3)
  blocks.push({ type: 'paragraph', attrs: { id: 'blank' }, content: [{ type: 'text', text: '   ' }] })
  blocks.push({ type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: '<script>alert(1)</script> & ', marks: [{ type: 'strong' }, { type: 'highlight' }] }] })
  const html = postHTML(blocks)
  assert.match(html, /^<p>The house was quiet/)
  assert.match(html, /I want to eat cake\./)
  assert.doesNotMatch(html, /a cat|ice cream|<br>|<p><\/p>/)
  assert.match(html, /<h2><mark><strong>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; <\/strong><\/mark><\/h2>$/)
})

class FakeSite {
  log = []
  objects = new Map()
  rows = new Map()
  failQuery = false
  failHook = false
  async query(sql, params = []) {
    this.log.push('query ' + sql.trim().split(/\s+/)[0])
    if (this.failQuery) throw Error('D1 returned HTTP 500.')
    if (sql.startsWith('INSERT')) this.rows.set(params[0], params)
    if (sql.startsWith('DELETE')) this.rows.delete(params[0])
    return []
  }
  async putObject(key, bytes, type) { this.log.push('put ' + key); this.objects.set(key, { bytes: Buffer.from(bytes), type }) }
  async deleteObject(key) { this.log.push('delete ' + key); this.objects.delete(key) }
  async triggerDeploy() {
    this.log.push('hook')
    if (this.failHook) throw Error('Workers Builds starts at most 10 deploy hook builds per minute.')
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-publish-'))
  const document = { id: 'story', title: 'The long way home', language: 'en', manuscript: sampleManuscript() }
  const path = join(dir, 'Stories.tinto')
  let store = ProjectStore.create(path, 'Stories', document)
  const files = { cover: join(dir, 'cover.png'), garden: join(dir, 'garden.jpg'), other: join(dir, 'other.png'), fake: join(dir, 'notes.png') }
  await writeFile(files.cover, png)
  await writeFile(files.garden, jpeg)
  await writeFile(files.other, Buffer.concat([png, Buffer.from('another')]))
  await writeFile(files.fake, 'plain text')
  const site = new FakeSite()
  const publisher = new Publisher(async () => site, () => Date.UTC(2026, 10, 20))
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return {
    site, publisher, files, document,
    get store() { return store },
    reopen() { store.close(); store = new ProjectStore(path) }
  }
}
const fields = { title: 'The kitchen', slug: 'the-kitchen', summary: 'Mara comes home.', date: '2026-11-20', tags: ['fiction', ' home ', 'fiction'] }

test('publishing uploads new images, then writes D1, then starts the rebuild', async t => {
  const f = await fixture(t)
  const result = await f.publisher.publish(f.store, {
    documentId: 'story', headingId: 'the-kitchen', fields,
    cover: { path: f.files.cover, name: 'cover.png', alt: ' A lit kitchen window ' },
    images: [{ path: f.files.garden, name: 'garden.jpg', alt: 'Pear tree' }]
  })
  assert.equal(result.deployError, null)
  const post = result.post
  assert.match(post.cover.key, new RegExp('^posts/' + post.id + '/[0-9a-f]{32}\\.png$'))
  assert.match(post.images[0].key, /\.jpg$/)
  assert.deepEqual(f.site.log, ['put ' + post.cover.key, 'put ' + post.images[0].key, 'query INSERT', 'hook'])
  const [id, slug, locale, title, summary, date, tags, body, cover, images] = f.site.rows.get(post.id)
  assert.deepEqual([id, slug, locale, title, summary, date, JSON.parse(tags)], [post.id, 'the-kitchen', 'en', 'The kitchen', 'Mara comes home.', '2026-11-20', ['fiction', 'home']])
  assert.match(body, /^<p>The house was quiet/)
  assert.doesNotMatch(body, /<h1>|The garden|a cat/)
  assert.deepEqual(JSON.parse(cover), { key: post.cover.key, type: 'image/png', alt: 'A lit kitchen window' })
  assert.deepEqual(JSON.parse(images), [{ key: post.images[0].key, type: 'image/jpeg', alt: 'Pear tree' }])
  assert.equal(f.site.objects.get(post.cover.key).type, 'image/png')
  f.reopen()
  assert.deepEqual(f.store.post('story', 'the-kitchen'), { ...post, deployPending: false })
  assert.equal(f.store.post('story', null), null)

  // Republishing unchanged images sends only the post; a removed image goes after the rebuild.
  f.site.log = []
  const again = await f.publisher.publish(f.store, {
    documentId: 'story', headingId: 'the-kitchen', fields: { ...fields, title: 'The kitchen, again' },
    cover: { key: post.cover.key, alt: 'Kitchen window' }, images: []
  })
  assert.deepEqual(f.site.log, ['query INSERT', 'hook', 'delete ' + post.images[0].key])
  assert.equal(again.post.id, post.id)
  assert.deepEqual(again.post.obsolete, [])
  assert.equal(again.post.cover.alt, 'Kitchen window')
  assert.deepEqual([...f.site.objects.keys()], [post.cover.key])
})

test('a failed rebuild keeps the saved post and its old images until a retry succeeds', async t => {
  const f = await fixture(t)
  const first = (await f.publisher.publish(f.store, { documentId: 'story', headingId: null, fields, cover: { path: f.files.cover, name: 'cover.png', alt: '' }, images: [] })).post
  f.site.failHook = true
  const result = await f.publisher.publish(f.store, { documentId: 'story', headingId: null, fields, cover: { path: f.files.other, name: 'other.png', alt: '' }, images: [] })
  assert.match(result.deployError, /10 deploy hook builds/)
  assert.equal(result.post.deployPending, true)
  assert.deepEqual(result.post.obsolete, [first.cover.key])
  assert.equal(f.site.objects.size, 2)
  f.reopen()
  assert.equal(f.store.post('story', null).deployPending, true)
  f.site.failHook = false
  f.site.log = []
  const retried = await f.publisher.rebuild(f.store, 'story', null)
  assert.deepEqual(f.site.log, ['hook', 'delete ' + first.cover.key])
  assert.equal(retried.post.deployPending, false)
  assert.deepEqual(retried.post.obsolete, [])
  assert.deepEqual(f.store.post('story', null), retried.post)
})

test('a D1 failure or invalid post leaves the local record unchanged', async t => {
  const f = await fixture(t)
  const input = { documentId: 'story', headingId: null, fields, cover: null, images: [] }
  const published = (await f.publisher.publish(f.store, input)).post
  f.site.failQuery = true
  f.site.log = []
  await assert.rejects(f.publisher.publish(f.store, { ...input, fields: { ...fields, title: 'Changed' }, images: [{ path: f.files.garden, name: 'garden.jpg', alt: '' }] }), /D1 returned HTTP 500/)
  assert.deepEqual(f.store.post('story', null), published)
  assert.deepEqual(f.site.log.filter(entry => entry === 'hook'), [])
  f.site.failQuery = false
  f.site.log = []
  const invalid = [
    [{ ...input, fields: { ...fields, slug: 'The Kitchen!' } }, /lowercase letters/],
    [{ ...input, fields: { ...fields, date: '2026-02-30' } }, /valid post date/],
    [{ ...input, fields: { ...fields, title: '   ' } }, /title/],
    [{ ...input, cover: { path: f.files.fake, name: 'notes.png', alt: '' } }, /notes\.png is not a PNG/],
    [{ ...input, cover: { key: 'posts/elsewhere/secret.png', alt: '' } }, /no longer part of this post/],
    [{ ...input, headingId: 'missing' }, /no longer in its document/]
  ]
  for (const [request, error] of invalid) await assert.rejects(f.publisher.publish(f.store, request), error)
  assert.deepEqual(f.site.log, [])
  f.store.save({ ...f.document, manuscript: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'empty' } }] } })
  await assert.rejects(f.publisher.publish(f.store, input), /Write some text/)
})

test('unpublishing deletes the row, then removes images and the local record after the rebuild', async t => {
  const f = await fixture(t)
  const post = (await f.publisher.publish(f.store, { documentId: 'story', headingId: null, fields, cover: { path: f.files.cover, name: 'cover.png', alt: '' }, images: [{ path: f.files.garden, name: 'garden.jpg', alt: '' }] })).post
  f.site.failHook = true
  const pending = await f.publisher.unpublish(f.store, 'story', null)
  assert.equal(f.site.rows.size, 0)
  assert.equal(pending.post.removed, true)
  assert.equal(f.site.objects.size, 2)
  f.site.failHook = false
  f.site.log = []
  assert.deepEqual(await f.publisher.rebuild(f.store, 'story', null), { post: null, deployError: null })
  assert.deepEqual(f.site.log, ['hook', 'delete ' + post.cover.key, 'delete ' + post.images[0].key])
  assert.equal(f.site.objects.size, 0)
  assert.equal(f.store.post('story', null), null)
})
