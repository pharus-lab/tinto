import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { createTintoBlog } from '../modules/cloudflare/worker.mjs'
import { tintoPosts } from '../modules/cloudflare/astro.mjs'
import exampleConfig from '../modules/cloudflare/tinto.config.mjs'

const bundle = await build({ stdin: { contents: "export * from './src/site-api'; export * from './src/publishing'; export * from './src/storage'; export * from './src/model'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { SiteClient, Publisher, ProjectStore, sampleManuscript } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

// D1's binding API over node:sqlite, so the module runs real SQL in tests.
class FakeD1 {
  db = new DatabaseSync(':memory:')
  prepare(sql) { return new Statement(this.db, sql, []) }
  async batch(statements) {
    this.db.exec('BEGIN')
    try {
      const results = statements.map(statement => statement.execute())
      this.db.exec('COMMIT')
      return results
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
class Statement {
  constructor(db, sql, values) { Object.assign(this, { db, sql, values }) }
  bind(...values) { return new Statement(this.db, this.sql, values) }
  execute() {
    const statement = this.db.prepare(this.sql)
    if (/^\s*select/i.test(this.sql)) return { success: true, results: statement.all(...this.values).map(row => ({ ...row })), meta: {} }
    return { success: true, results: [], meta: { changes: Number(statement.run(...this.values).changes) } }
  }
  async run() { return this.execute() }
  async all() { return this.execute() }
}
class FakeR2 {
  objects = new Map()
  async put(key, value, options) {
    const bytes = Buffer.from(value)
    this.objects.set(key, { bytes, etag: createHash('md5').update(bytes).digest('hex'), type: options?.httpMetadata?.contentType })
  }
  async head(key) {
    const object = this.objects.get(key)
    return object ? { key, size: object.bytes.length, httpEtag: '"' + object.etag + '"', httpMetadata: { contentType: object.type } } : null
  }
  async get(key) {
    const head = await this.head(key)
    return head ? { ...head, body: new Blob([this.objects.get(key).bytes]).stream() } : null
  }
  async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key) }
  async list({ prefix }) { return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false } }
}

const key = 'module-test-key-0123456789abcdef'
const config = { name: 'Field Notes', site: 'https://blog.example', basePath: '/api/tinto', languages: { en: 'en', es: 'castellano' }, postPath: post => '/' + post.locale + '/notes/' + post.slug }
const endpoint = 'https://blog.example/api/tinto'
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cover pixels')])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('gallery pixels')])
const nameOf = (bytes, ext) => createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.' + ext
const id = '6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10'

function site({ hook = '' } = {}) {
  const clock = { time: Date.UTC(2026, 10, 21) }
  const blog = createTintoBlog(config, { now: () => clock.time })
  const env = { TINTO_DB: new FakeD1(), TINTO_MEDIA: new FakeR2(), TINTO_API_KEY: key, TINTO_DEPLOY_HOOK: hook }
  const call = (method, path, { body, type, auth = key, headers = {} } = {}) => blog.fetch(new Request('https://blog.example' + path, {
    method, body, headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(type ? { 'Content-Type': type } : {}), ...headers }
  }), env)
  return { blog, env, clock, call }
}
const post = (fields = {}) => ({
  slug: 'first-light', language: 'en', title: 'First light', summary: 'A short note.', date: '2026-11-21', tags: ['notes'],
  html: '<p>Some <strong>bold</strong> &amp; <mark>marked</mark> text.</p>', cover: null, images: [], updatedAt: '2026-11-21T18:00:00.000Z', ...fields
})

test('the module answers only under its base path and only to the right key', async () => {
  const { blog, env, call } = site()
  assert.equal(await blog.fetch(new Request('https://blog.example/en/about'), env), null)
  assert.equal(await blog.fetch(new Request('https://blog.example/api/tintoextra'), env), null)
  const info = await call('GET', '/api/tinto')
  assert.deepEqual([info.status, await info.json()], [200, { tinto: 1, name: 'Field Notes' }])
  assert.equal(info.headers.get('Cache-Control'), 'no-store')
  assert.equal(info.headers.get('X-Content-Type-Options'), 'nosniff')
  for (const auth of [null, 'wrong-key-of-enough-length-000', key + 'x']) {
    const response = await call('GET', '/api/tinto', { auth })
    assert.deepEqual([response.status, (await response.json()).error], [401, 'The API key is not valid for this site.'])
  }
  for (const missing of [undefined, 'short']) {
    const response = await blog.fetch(new Request(endpoint, { headers: { Authorization: 'Bearer ' + key } }), { ...env, TINTO_API_KEY: missing })
    assert.equal(response.status, 503)
    assert.match((await response.json()).error, /Set the TINTO_API_KEY secret/)
  }
  const unbound = await blog.fetch(new Request(endpoint, { headers: { Authorization: 'Bearer ' + key } }), { TINTO_API_KEY: key })
  assert.match((await unbound.json()).error, /TINTO_DB \(D1\) and TINTO_MEDIA \(R2\) bindings/)
  assert.equal((await call('POST', '/api/tinto')).status, 405)
  assert.equal((await call('GET', '/api/tinto/elsewhere')).status, 404)
  assert.equal((await call('GET', '/api/tinto/elsewhere', { auth: null })).status, 401)
  const preview = await blog.fetch(new Request('https://preview.workers.dev/api/tinto/feed'), env)
  assert.equal(preview.headers.get('X-Robots-Tag'), 'noindex, nofollow')
})

test('images are stored only when their name, type and bytes agree', async () => {
  const { env, call } = site()
  const file = nameOf(png, 'png')
  const cases = [
    ['/posts/not-a-uuid/images/' + file, png, 'image/png', 400],
    ['/posts/' + id + '/images/cover.png', png, 'image/png', 400],
    ['/posts/' + id + '/images/' + file, png, 'image/jpeg', 422],
    ['/posts/' + id + '/images/' + nameOf(png, 'jpg'), png, 'image/jpeg', 422],
    ['/posts/' + id + '/images/' + nameOf(jpeg, 'png'), png, 'image/png', 422],
    ['/posts/' + id + '/images/' + file, Buffer.alloc(15 * 1024 * 1024 + 1), 'image/png', 413]
  ]
  for (const [path, body, type, status] of cases) assert.equal((await call('PUT', '/api/tinto' + path, { body, type })).status, status, path)
  assert.equal(env.TINTO_MEDIA.objects.size, 0)
  assert.equal((await call('PUT', '/api/tinto/posts/' + id + '/images/' + file, { body: png, type: 'image/png' })).status, 201)
  assert.deepEqual([...env.TINTO_MEDIA.objects.keys()], ['tinto/' + id + '/' + file])

  const image = await call('GET', '/api/tinto/media/' + id + '/' + file, { auth: null })
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  assert.equal(image.headers.get('Content-Type'), 'image/png')
  assert.equal(image.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  assert.equal(image.headers.get('Content-Security-Policy'), "default-src 'none'")
  const etag = image.headers.get('ETag')
  assert.equal((await call('GET', '/api/tinto/media/' + id + '/' + file, { auth: null, headers: { 'If-None-Match': etag } })).status, 304)
  const head = await call('HEAD', '/api/tinto/media/' + id + '/' + file, { auth: null })
  assert.deepEqual([head.status, head.headers.get('Content-Length'), await head.text()], [200, String(png.length), ''])
  assert.equal((await call('GET', '/api/tinto/media/' + id + '/' + nameOf(jpeg, 'jpg'), { auth: null })).status, 404)
  assert.equal((await call('GET', '/api/tinto/media/' + id + '/..%2Fsecret.png', { auth: null })).status, 404)
  assert.equal((await call('GET', '/api/tinto/media/' + id + '/../secret.png', { auth: null })).status, 401)
  assert.equal((await call('PUT', '/api/tinto/media/' + id + '/' + file, { auth: null })).status, 405)
})

test('posts are checked, saved once per locale and address, and published in the feed', async () => {
  const { env, call } = site()
  const send = (postId, body) => call('PUT', '/api/tinto/posts/' + postId, { body: JSON.stringify(body), type: 'application/json' })
  const invalid = [
    [post({ html: '<p onclick="steal()">Hi</p>' }), 422, /markup this site does not accept/],
    [post({ html: '<p>Hi</p><script>alert(1)</script>' }), 422, /markup/],
    [post({ slug: 'First Light' }), 422, /lowercase letters/],
    [post({ date: '2026-02-30' }), 422, /real date/],
    [post({ language: 'fr' }), 422, /^This site publishes posts in en, es only\.$/],
    [post({ cover: { file: nameOf(png, 'png'), type: 'image/png', alt: '' } }), 422, /has not been uploaded/],
    [post({ cover: { file: nameOf(png, 'png'), type: 'image/svg+xml' } }), 422, /not a valid image reference/],
    [post({ tags: [1] }), 422, /Tags must be a list/],
    ['not json', 400, /Send the post as JSON/]
  ]
  for (const [body, status, error] of invalid) {
    const response = await call('PUT', '/api/tinto/posts/' + id, { body: typeof body === 'string' ? body : JSON.stringify(body), type: 'application/json' })
    assert.equal(response.status, status)
    assert.match((await response.json()).error, error)
  }
  const saved = await send(id, post({ language: 'en-GB', tags: ['notes', ' notes ', 'field'] }))
  assert.deepEqual([saved.status, await saved.json()], [200, { url: 'https://blog.example/en/notes/first-light' }])
  const other = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
  const conflict = await send(other, post())
  assert.deepEqual([conflict.status, (await conflict.json()).error], [409, 'Another post in this language already uses the address “first-light”. Choose a different address.'])
  assert.equal((await send(other, post({ language: 'es', title: 'Primera luz', date: '2026-11-22' }))).status, 200)

  const feed = await call('GET', '/api/tinto/feed', { auth: null })
  assert.equal(feed.headers.get('Cache-Control'), 'no-store')
  const body = await feed.json()
  assert.deepEqual(body.posts.map(item => [item.locale, item.language, item.slug, item.title, item.url]), [
    ['castellano', 'es', 'first-light', 'Primera luz', 'https://blog.example/castellano/notes/first-light'],
    ['en', 'en-GB', 'first-light', 'First light', 'https://blog.example/en/notes/first-light']
  ])
  assert.deepEqual(body.posts[1].tags, ['notes', 'field'])
  assert.equal(body.posts[1].html, post().html)
  const empty = await site().call('GET', '/api/tinto/feed', { auth: null })
  assert.deepEqual(await empty.json(), { tinto: 1, name: 'Field Notes', posts: [] })
  assert.equal(env.TINTO_DB.db.prepare('SELECT COUNT(*) AS n FROM tinto_posts').get().n, 2)
})

test('the deploy hook runs after every change, and a failed hook is reported for a retry', async t => {
  const hooks = []
  let status = 200
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (address, init) => {
    hooks.push([String(address), init?.method])
    return new Response(null, { status })
  })
  t.after(() => { globalThis.fetch = realFetch })
  const { call } = site({ hook: 'https://hooks.example/build' })
  const body = JSON.stringify(post())
  assert.equal((await call('PUT', '/api/tinto/posts/' + id, { body, type: 'application/json' })).status, 200)
  status = 429
  const failed = await call('PUT', '/api/tinto/posts/' + id, { body, type: 'application/json' })
  assert.deepEqual([failed.status, (await failed.json()).error], [502, 'The post was saved, but the site rebuild did not start (HTTP 429). Try again in a minute.'])
  status = 200
  assert.equal((await call('DELETE', '/api/tinto/posts/' + id)).status, 204)
  // A retried removal finds no post but still rebuilds the site.
  assert.equal((await call('DELETE', '/api/tinto/posts/' + id)).status, 404)
  assert.deepEqual(hooks, Array(4).fill(['https://hooks.example/build', 'POST']))
})

// The same image files and posts as Tinto sends them, through its real client.
async function tintoProject(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-module-'))
  const store = ProjectStore.create(join(dir, 'Notes.tinto'), 'Notes', { id: 'story', title: 'The long way home', language: 'en', manuscript: sampleManuscript() })
  store.save({ id: 'cuento', title: 'El camino', language: 'es-MX', manuscript: sampleManuscript() })
  store.save({ id: 'histoire', title: 'Le chemin', language: 'fr', manuscript: sampleManuscript() })
  const files = { cover: join(dir, 'cover.png'), garden: join(dir, 'garden.jpg') }
  await writeFile(files.cover, png)
  await writeFile(files.garden, jpeg)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, files }
}

test('Tinto publishes, updates, translates and unpublishes through the module', async t => {
  const { blog, env, clock, call } = site({ hook: 'https://hooks.example/build' })
  const hooks = []
  t.mock.method(globalThis, 'fetch', async (address, init) => {
    const url = String(address)
    if (url === 'https://hooks.example/build') { hooks.push(init.method); return new Response(null, { status: 200 }) }
    return (await blog.fetch(new Request(url, init), env)) ?? new Response('Site page', { status: 404 })
  })
  const { store, files } = await tintoProject(t)
  const client = new SiteClient({ endpoint, key })
  assert.deepEqual(await client.info(), { name: 'Field Notes' })
  const publisher = new Publisher(async () => client, () => clock.time)
  const fields = { title: 'The long way home', slug: 'the-long-way-home', summary: 'Mara comes home.', date: '2026-11-21', tags: ['fiction'] }

  const first = await publisher.publish(store, {
    siteId: 'field-notes', documentId: 'story', headingId: null, fields,
    cover: { path: files.cover, name: 'cover.png', alt: 'Kitchen window' }, images: [{ path: files.garden, name: 'garden.jpg', alt: 'Pear tree' }]
  })
  assert.equal(first.url, 'https://blog.example/en/notes/the-long-way-home')
  assert.deepEqual([...env.TINTO_MEDIA.objects.keys()].sort(), ['tinto/' + first.id + '/' + first.cover.file, 'tinto/' + first.id + '/' + first.images[0].file].sort())
  let feed = (await (await call('GET', '/api/tinto/feed', { auth: null })).json()).posts
  assert.equal(feed.length, 1)
  assert.deepEqual(feed[0].cover, { file: first.cover.file, type: 'image/png', alt: 'Kitchen window', url: '/api/tinto/media/' + first.id + '/' + first.cover.file })
  const served = await call('GET', feed[0].images[0].url, { auth: null })
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpeg)

  // Dropping the gallery image keeps it for an hour, then the next change removes it.
  await publisher.publish(store, { siteId: 'field-notes', documentId: 'story', headingId: null, fields, cover: { file: first.cover.file, alt: 'Window' }, images: [] })
  const gallery = 'tinto/' + first.id + '/' + first.images[0].file
  assert.ok(env.TINTO_MEDIA.objects.has(gallery))
  assert.deepEqual(env.TINTO_DB.db.prepare('SELECT key FROM tinto_trash').all().map(row => row.key), [gallery])

  const spanish = await publisher.publish(store, { siteId: 'field-notes', documentId: 'cuento', headingId: null, fields: { ...fields, title: 'El camino' }, cover: null, images: [] })
  assert.equal(spanish.url, 'https://blog.example/castellano/notes/the-long-way-home')
  await assert.rejects(publisher.publish(store, { siteId: 'field-notes', documentId: 'histoire', headingId: null, fields, cover: null, images: [] }), /^Error: This site publishes posts in en, es only\.$/)
  await assert.rejects(publisher.publish(store, { siteId: 'field-notes', documentId: 'story', headingId: 'the-kitchen', fields, cover: null, images: [] }), /already uses the address “the-long-way-home”/)

  clock.time += 61 * 60 * 1000
  await publisher.unpublish(store, 'field-notes', 'story', null)
  assert.ok(!env.TINTO_MEDIA.objects.has(gallery))
  assert.ok(env.TINTO_MEDIA.objects.has('tinto/' + first.id + '/' + first.cover.file), 'the cover waits an hour after the post is removed')
  feed = (await (await call('GET', '/api/tinto/feed', { auth: null })).json()).posts
  assert.deepEqual(feed.map(item => [item.locale, item.title]), [['castellano', 'El camino']])
  assert.deepEqual(store.posts('story', null), [])
  assert.equal(hooks.length, 4)
})

test('the Astro loader stores the feed, waits for a first deployment and keeps live posts on failure', async t => {
  const { blog, env, call } = site()
  await call('PUT', '/api/tinto/posts/' + id, { body: JSON.stringify(post()), type: 'application/json' })
  let reply = () => blog.fetch(new Request(endpoint + '/feed'), env)
  const requested = []
  t.mock.method(globalThis, 'fetch', async address => { requested.push(String(address)); return reply() })
  const saved = process.env.WORKERS_CI
  t.after(() => { if (saved === undefined) delete process.env.WORKERS_CI; else process.env.WORKERS_CI = saved })
  const run = async () => {
    const entries = new Map([['stale/entry', {}]])
    const logs = []
    const context = {
      store: { clear: () => entries.clear(), set: entry => entries.set(entry.id, entry) },
      logger: { info: text => logs.push('info ' + text), warn: text => logs.push('warn ' + text) },
      generateDigest: data => JSON.stringify(data)
    }
    await tintoPosts(config).load(context)
    return { entries, logs }
  }

  delete process.env.WORKERS_CI
  let result = await run()
  assert.deepEqual([...result.entries.keys()], ['en/first-light'])
  assert.equal(result.entries.get('en/first-light').data.url, 'https://blog.example/en/notes/first-light')
  assert.deepEqual(result.logs, ['info Loaded 1 Tinto post (en 1).'])
  assert.deepEqual(requested, ['https://blog.example/api/tinto/feed'])

  reply = async () => new Response('Page not found', { status: 404 })
  process.env.WORKERS_CI = '1'
  result = await run()
  assert.equal(result.entries.size, 0)
  assert.match(result.logs[0], /^warn There is no Tinto feed at .* yet/)

  reply = async () => new Response('Error', { status: 500 })
  await assert.rejects(run(), /returned HTTP 500\. The build stops so the live site keeps its posts\./)
  delete process.env.WORKERS_CI
  result = await run()
  assert.deepEqual([result.entries.size, result.logs], [0, ['warn The Tinto feed at https://blog.example/api/tinto/feed returned HTTP 500. Building without Tinto posts.']])

  reply = async () => Response.json({ tinto: 1, posts: [{ ...post(), id, locale: 'en', html: '<img src=x onerror=alert(1)>' }] })
  await assert.rejects(run(), new RegExp('Tinto post ' + id + ': The post body contains markup'))
  reply = async () => Response.json({ tinto: 1, posts: [{ ...post(), id, locale: 'fr' }] })
  await assert.rejects(run(), /locale "fr" is not one of this site's locales/)
})

test('the example configuration is valid and a broken one fails when the module starts', () => {
  assert.doesNotThrow(() => createTintoBlog(exampleConfig))
  for (const broken of [{ ...config, name: '' }, { ...config, site: 'example.com' }, { ...config, basePath: 'api' }, { ...config, languages: { english: 'en' } }]) {
    assert.throws(() => createTintoBlog(broken), /tinto\.config\.mjs/)
  }
})
