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
import { renderPreview, settings as moduleSettings } from '../modules/cloudflare/shared.mjs'

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
  async first() { return this.execute().results[0] ?? null }
}
// R2 in memory, including ranged reads.
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
  async get(key, options) {
    const head = await this.head(key)
    if (!head) return null
    let bytes = this.objects.get(key).bytes
    let range
    const header = options?.range?.get?.('Range')
    const match = header && /^bytes=(\d+)-(\d*)$/.exec(header)
    if (match) {
      const offset = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
      range = { offset, length: end - offset + 1 }
      bytes = bytes.subarray(offset, end + 1)
    }
    return { ...head, range, body: new Blob([bytes]).stream() }
  }
  async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key) }
  async list({ prefix }) { return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false } }
}

const key = 'module-test-key-0123456789abcdef'
const config = {
  name: 'Field Notes', site: 'https://blog.example', basePath: '/api/tinto', languages: { en: 'en', es: 'castellano' },
  categories: { notes: 'Notes', essays: 'Essays' }, postPath: post => '/' + post.locale + '/' + post.category + '/' + post.slug
}
const endpoint = 'https://blog.example/api/tinto'
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cover pixels')])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('gallery pixels')])
const pdf = Buffer.from('%PDF-1.7\nfield notes\n%%EOF')
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.from('rain on the window')])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const csv = Buffer.from('date,rain\n2026-11-21,12\n')
const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(26)])
const nameOf = (bytes, ext) => createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.' + ext
const id = '6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10'

// The site's static pages, including the preview page with its markers.
const previewTemplate = '<!doctype html><title>%%title%% · Field Notes</title><body class="site"><h1 class="post-title">%%title%%</h1><p>%%category%% · %%date%%</p>'
  + '<template data-tinto-each="cover"><img class="cover" src="%%url%%" alt="%%alt%%"></template><div class="prose">%%body%%</div>'
  + '<ul><template data-tinto-each="attachments"><li><a href="%%url%%">%%title%%</a> (%%size%%)</li></template></ul></body>'
const assets = (pages = { '/tinto-preview': previewTemplate }) => ({
  async fetch(request) {
    const page = pages[new URL(request.url).pathname]
    return page ? new Response(page, { headers: { 'Content-Type': 'text/html' } }) : new Response('Not found', { status: 404 })
  }
})

function site({ hook = '', settings = config, pages } = {}) {
  const clock = { time: Date.UTC(2026, 10, 21) }
  const blog = createTintoBlog(settings, { now: () => clock.time })
  const env = { TINTO_DB: new FakeD1(), TINTO_MEDIA: new FakeR2(), TINTO_API_KEY: key, TINTO_DEPLOY_HOOK: hook, ASSETS: assets(pages) }
  const call = (method, path, { body, type, auth = key, headers = {} } = {}) => blog.fetch(new Request('https://blog.example' + path, {
    method, body, headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(type ? { 'Content-Type': type } : {}), ...headers }
  }), env)
  const upload = (bytes, ext, type, postId = id) => call('PUT', '/api/tinto/posts/' + postId + '/files/' + nameOf(bytes, ext), { body: bytes, type })
  const send = (body, postId = id) => call('PUT', '/api/tinto/posts/' + postId, { body: typeof body === 'string' ? body : JSON.stringify(body), type: 'application/json' })
  return { blog, env, clock, call, upload, send }
}
const post = (fields = {}) => ({
  slug: 'first-light', language: 'en', category: 'notes', status: 'published', title: 'First light', summary: 'A short note.', date: '2026-11-21', tags: ['notes'],
  html: '<p>Some <strong>bold</strong> &amp; <u>underlined</u> and <mark>older</mark> text.</p>', cover: null, images: [], attachments: [],
  updatedAt: '2026-11-21T18:00:00.000Z', ...fields
})

test('the module answers only under its base path and only to the right key', async () => {
  const { blog, env, call } = site()
  assert.equal(await blog.fetch(new Request('https://blog.example/en/about'), env), null)
  assert.equal(await blog.fetch(new Request('https://blog.example/api/tintoextra'), env), null)
  const info = await call('GET', '/api/tinto')
  assert.deepEqual([info.status, await info.json()], [200, { tinto: 2, name: 'Field Notes', categories: [{ id: 'notes', label: 'Notes' }, { id: 'essays', label: 'Essays' }] }])
  assert.equal(info.headers.get('Cache-Control'), 'no-store')
  for (const auth of [null, 'wrong-key-of-enough-length-000', key + 'x']) {
    const response = await call('GET', '/api/tinto', { auth })
    assert.deepEqual([response.status, (await response.json()).error], [401, 'The API key is not valid for this site.'])
  }
  for (const missing of [undefined, 'short']) {
    const response = await blog.fetch(new Request(endpoint, { headers: { Authorization: 'Bearer ' + key } }), { ...env, TINTO_API_KEY: missing })
    assert.equal(response.status, 503)
  }
  const unbound = await blog.fetch(new Request(endpoint, { headers: { Authorization: 'Bearer ' + key } }), { TINTO_API_KEY: key })
  assert.match((await unbound.json()).error, /TINTO_DB \(D1\) and TINTO_MEDIA \(R2\) bindings/)
  assert.equal((await call('POST', '/api/tinto')).status, 405)
  assert.equal((await call('GET', '/api/tinto/elsewhere')).status, 404)
  assert.equal((await call('GET', '/api/tinto/elsewhere', { auth: null })).status, 401)
  assert.equal((await blog.fetch(new Request('https://preview.workers.dev/api/tinto/feed'), env)).headers.get('X-Robots-Tag'), 'noindex, nofollow')
})

test('files are checked by name, type and bytes, then stored and served by class', async () => {
  const { env, call, upload } = site()
  const accepted = [[png, 'png', 'image/png', 'images'], [pdf, 'pdf', 'application/pdf', 'documents'], [mp3, 'mp3', 'audio/mpeg', 'audio'],
    [mp4, 'mp4', 'video/mp4', 'video'], [csv, 'csv', 'text/csv', 'downloads'], [zip, 'zip', 'application/zip', 'downloads']]
  for (const [bytes, ext, type] of accepted) assert.equal((await upload(bytes, ext, type)).status, 201, ext)
  assert.deepEqual([...env.TINTO_MEDIA.objects.keys()].sort(), accepted.map(([bytes, ext, , folder]) => 'tinto/' + id + '/' + folder + '/' + nameOf(bytes, ext)).sort())
  const refused = [
    ['/posts/not-a-uuid/files/' + nameOf(png, 'png'), png, 'image/png', 400],
    ['/posts/' + id + '/files/cover.png', png, 'image/png', 400],
    ['/posts/' + id + '/files/' + nameOf(png, 'exe'), png, 'application/octet-stream', 400],
    ['/posts/' + id + '/files/' + nameOf(png, 'png'), png, 'image/jpeg', 422],
    ['/posts/' + id + '/files/' + nameOf(pdf, 'png'), pdf, 'image/png', 422],
    ['/posts/' + id + '/files/' + nameOf(jpeg, 'png'), png, 'image/png', 422],
    ['/posts/' + id + '/files/' + nameOf(Buffer.from('a\0b'), 'csv'), Buffer.from('a\0b'), 'text/csv', 422],
    ['/posts/' + id + '/files/' + nameOf(png, 'png'), Buffer.alloc(15 * 1024 * 1024 + 1), 'image/png', 413]
  ]
  for (const [path, body, type, status] of refused) assert.equal((await call('PUT', '/api/tinto' + path, { body, type })).status, status, path)

  const get = (bytes, ext, headers) => call('GET', '/api/tinto/files/' + id + '/' + nameOf(bytes, ext), { auth: null, headers })
  const document = await get(pdf, 'pdf')
  assert.deepEqual([document.status, document.headers.get('Content-Type'), document.headers.get('Content-Disposition'), document.headers.get('Accept-Ranges'), document.headers.get('Content-Security-Policy')],
    [200, 'application/pdf', 'inline', 'bytes', null])
  assert.deepEqual(Buffer.from(await document.arrayBuffer()), pdf)
  assert.equal(document.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  const part = await get(mp3, 'mp3', { Range: 'bytes=0-2' })
  assert.deepEqual([part.status, part.headers.get('Content-Range'), part.headers.get('Content-Length'), Buffer.from(await part.arrayBuffer()).toString()], [206, 'bytes 0-2/' + mp3.length, '3', 'ID3'])
  assert.equal((await get(png, 'png', { Range: 'bytes=0-2' })).status, 200, 'images are always sent whole')
  assert.equal((await get(csv, 'csv')).headers.get('Content-Disposition'), 'attachment')
  const etag = (await get(png, 'png')).headers.get('ETag')
  assert.equal((await get(png, 'png', { 'If-None-Match': etag })).status, 304)
  const head = await call('HEAD', '/api/tinto/files/' + id + '/' + nameOf(png, 'png'), { auth: null })
  assert.deepEqual([head.status, head.headers.get('Content-Length'), await head.text()], [200, String(png.length), ''])
  assert.equal((await get(jpeg, 'jpg')).status, 404)
  assert.equal((await call('GET', '/api/tinto/files/' + id + '/..%2Fsecret.png', { auth: null })).status, 404)
  assert.equal((await call('PUT', '/api/tinto/files/' + id + '/' + nameOf(png, 'png'), { auth: null })).status, 405)
})

test('posts are checked against the site, saved once per locale, category and address, and drafts stay out of the feed', async () => {
  const { upload, send, call } = site()
  await upload(png, 'png', 'image/png')
  await upload(pdf, 'pdf', 'application/pdf')
  const cover = { file: nameOf(png, 'png'), type: 'image/png', alt: 'A bench' }
  const document = { file: nameOf(pdf, 'pdf'), type: 'application/pdf', title: 'Field notes', size: pdf.length }
  const invalid = [
    [post({ html: '<p onclick="steal()">Hi</p>' }), /markup this site does not accept/],
    [post({ category: '' }), /^Choose one of this site’s categories: Notes, Essays\.$/],
    [post({ category: 'diary' }), /categories: Notes, Essays/],
    [post({ status: 'hidden' }), /draft or published/],
    [post({ language: 'fr' }), /^This site publishes posts in en, es only\.$/],
    [post({ cover: { ...document, alt: '' } }), /cover is not a valid file reference/],
    [post({ attachments: [{ ...cover, title: 'Bench' }] }), /attachment 1 is not a valid file reference/],
    [post({ attachments: [{ ...document, title: ' ' }] }), /needs a title/],
    [post({ attachments: [{ ...document, file: nameOf(mp3, 'mp3'), type: 'audio/mpeg' }] }), /has not been uploaded/]
  ]
  for (const [body, error] of invalid) {
    const response = await send(body)
    assert.equal(response.status, 422)
    assert.match((await response.json()).error, error)
  }
  const saved = await send(post({ language: 'en-GB', cover, attachments: [document] }))
  assert.deepEqual([saved.status, await saved.json()], [200, { url: 'https://blog.example/en/notes/first-light' }])
  const other = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
  const conflict = await send(post(), other)
  assert.deepEqual([conflict.status, (await conflict.json()).error], [409, 'Another post in this language and category already uses the address “first-light”. Choose a different address.'])
  assert.equal((await send(post({ category: 'essays' }), other)).status, 200, 'the same address can live in another category')
  const third = '11111111-2222-4333-8444-555555555555'
  const draft = await send(post({ language: 'es', category: 'notes', title: 'Primera luz', status: 'draft' }), third)
  assert.deepEqual(await draft.json(), { url: null })

  const feed = await (await call('GET', '/api/tinto/feed', { auth: null })).json()
  assert.equal(feed.tinto, 2)
  assert.deepEqual(feed.posts.map(item => [item.locale, item.category, item.slug, item.url]), [
    ['en', 'notes', 'first-light', 'https://blog.example/en/notes/first-light'],
    ['en', 'essays', 'first-light', 'https://blog.example/en/essays/first-light']
  ])
  assert.deepEqual(feed.posts[0].attachments, [{ ...document, url: '/api/tinto/files/' + id + '/' + document.file }])
  assert.equal(feed.posts[0].cover.url, '/api/tinto/files/' + id + '/' + cover.file)
  assert.deepEqual(await (await site().call('GET', '/api/tinto/feed', { auth: null })).json(), { tinto: 2, name: 'Field Notes', posts: [] })
})

test('the deploy hook runs only for changes that touch published posts', async t => {
  const hooks = []
  let status = 200
  t.mock.method(globalThis, 'fetch', async (address, init) => { hooks.push(init?.method); return new Response(null, { status }) })
  const { send, call } = site({ hook: 'https://hooks.example/build' })
  const draftId = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
  assert.equal((await send(post({ status: 'draft' }), draftId)).status, 200)
  assert.equal((await call('DELETE', '/api/tinto/posts/' + draftId)).status, 204)
  assert.equal(hooks.length, 0, 'a draft is on no page')
  assert.equal((await send(post())).status, 200)
  assert.equal((await send(post({ status: 'draft' }))).status, 200, 'taking a post back to drafts')
  assert.equal((await send(post())).status, 200)
  status = 429
  const failed = await send(post())
  assert.deepEqual([failed.status, (await failed.json()).error], [502, 'The post was saved, but the site rebuild did not start (HTTP 429). Try again in a minute.'])
  status = 200
  assert.equal((await call('DELETE', '/api/tinto/posts/' + id)).status, 204)
  assert.equal((await call('DELETE', '/api/tinto/posts/' + id)).status, 404)
  assert.equal(hooks.length, 6)
})

test('a protocol 1 table is upgraded in place, keeping its posts', async () => {
  const { env, send, call } = site({ settings: { ...config, categories: null, postPath: null } })
  env.TINTO_DB.db.exec(`CREATE TABLE tinto_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, language TEXT NOT NULL, locale TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', html TEXT NOT NULL,
    cover TEXT, images TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, UNIQUE (locale, slug));
    INSERT INTO tinto_posts VALUES ('${id}', 'old-post', 'en', 'en', 'Old post', '', '2026-11-20', '[]', '<p>Old</p>', NULL, '[]', '2026-11-20T00:00:00.000Z');`)
  assert.equal((await send(post({ category: '', slug: 'new-post' }), '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9')).status, 200)
  const feed = await (await call('GET', '/api/tinto/feed', { auth: null })).json()
  assert.deepEqual(feed.posts.map(item => [item.slug, item.category, item.attachments]), [['new-post', '', []], ['old-post', '', []]])
  // An image stored by protocol 1, without a class folder, is still served.
  await env.TINTO_MEDIA.put('tinto/' + id + '/' + nameOf(png, 'png'), png, { httpMetadata: { contentType: 'image/png' } })
  assert.equal((await call('GET', '/api/tinto/files/' + id + '/' + nameOf(png, 'png'), { auth: null })).status, 200)
})

test('the preview page is filled in one pass, with escaped fields, the post HTML and repeated items', () => {
  const settings = moduleSettings(config)
  const html = renderPreview(previewTemplate + '<ul><template data-tinto-each="tags"><li>%%tag%%</li></template></ul><template data-tinto-each="images"><img src="%%url%%"></template>%%unknown%%', {
    id, slug: 'first-light', language: 'en', locale: 'en', category: 'notes', title: 'A <b> "%%summary%%" title', summary: 'Never shown', date: '2026-11-21', tags: ['rain', 'a&b'],
    html: '<p>Some <u>underlined</u> text.</p>', cover: { file: 'c.png', type: 'image/png', alt: 'A "bench"', url: '/api/tinto/files/x/c.png' }, images: [],
    attachments: [{ file: 'n.pdf', type: 'application/pdf', title: 'Notes', size: 2_400_000, url: '/api/tinto/files/x/n.pdf' }], updatedAt: '', url: null
  }, settings)
  assert.match(html, /<title>A &lt;b&gt; &quot;%%summary%%&quot; title · Field Notes<\/title>/)
  assert.match(html, /<p>Notes · 2026-11-21<\/p>/)
  assert.match(html, /<img class="cover" src="\/api\/tinto\/files\/x\/c\.png" alt="A &quot;bench&quot;">/)
  assert.match(html, /<div class="prose"><p>Some <u>underlined<\/u> text\.<\/p><\/div>/)
  assert.match(html, /<li><a href="\/api\/tinto\/files\/x\/n\.pdf">Notes<\/a> \(2\.3 MB\)<\/li>/)
  assert.match(html, /<li>rain<\/li><li>a&amp;b<\/li>/)
  assert.doesNotMatch(html, /<template|Never shown/)
  assert.match(html, /%%unknown%%$/)
})

test('a preview is stored beside the live post and shown through a signed, expiring link', async t => {
  const hooks = []
  t.mock.method(globalThis, 'fetch', async () => { hooks.push('hook'); return new Response(null, { status: 200 }) })
  const { clock, call, upload, send } = site({ hook: 'https://hooks.example/build' })
  await upload(png, 'png', 'image/png')
  const cover = { file: nameOf(png, 'png'), type: 'image/png', alt: 'A bench' }
  assert.equal((await send(post({ title: 'Live title', cover }))).status, 200)
  hooks.length = 0
  const preview = await call('PUT', '/api/tinto/previews/' + id, { body: JSON.stringify(post({ title: 'Draft title', cover })), type: 'application/json' })
  assert.equal(preview.status, 200)
  const { url } = await preview.json()
  assert.match(url, new RegExp('^https://blog\\.example/api/tinto/preview/' + id + '\\?expires=\\d+&sig=[0-9a-f]{64}$'))
  assert.equal(hooks.length, 0, 'a preview starts no rebuild')
  const feed = await (await call('GET', '/api/tinto/feed', { auth: null })).json()
  assert.deepEqual(feed.posts.map(item => item.title), ['Live title'])

  const page = await call('GET', new URL(url).pathname + new URL(url).search, { auth: null })
  assert.deepEqual([page.status, page.headers.get('Content-Type'), page.headers.get('Cache-Control'), page.headers.get('X-Robots-Tag'), page.headers.get('Referrer-Policy')],
    [200, 'text/html; charset=utf-8', 'no-store', 'noindex, nofollow', 'no-referrer'])
  const html = await page.text()
  assert.match(html, /<h1 class="post-title">Draft title<\/h1>/)
  assert.match(html, new RegExp('<img class="cover" src="/api/tinto/files/' + id + '/' + cover.file + '" alt="A bench">'))
  assert.match(html, /<div class="prose"><p>Some <strong>bold<\/strong>/)

  const tampered = url.replace(/sig=[0-9a-f]/, match => match.slice(0, -1) + (match.endsWith('0') ? '1' : '0'))
  assert.equal((await call('GET', new URL(tampered).pathname + new URL(tampered).search, { auth: null })).status, 404)
  assert.equal((await call('GET', '/tinto-preview', { auth: null })).status, 404, 'the template itself stays private')
  assert.equal((await call('GET', '/tinto-preview.html', { auth: null })).status, 404)
  clock.time += 61 * 60 * 1000
  const expired = await call('GET', new URL(url).pathname + new URL(url).search, { auth: null })
  assert.equal(expired.status, 410)
  assert.match(await expired.text(), /expired/)
  assert.equal((await call('PUT', '/api/tinto/previews/' + id, { body: JSON.stringify(post({ cover })), type: 'application/json', auth: null })).status, 401)
})

test('a site without a preview page says so before anything is stored', async () => {
  const { call } = site({ pages: {} })
  const response = await call('PUT', '/api/tinto/previews/' + id, { body: JSON.stringify(post()), type: 'application/json' })
  assert.deepEqual([response.status, (await response.json()).error], [422, 'This site has no preview page yet. Ask your agent to add one (see "Preview page" in tinto/README.md).'])
})

// The same files and posts as Tinto sends them, through its real client.
async function tintoProject(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-module-'))
  const store = ProjectStore.create(join(dir, 'Notes.tinto'), 'Notes', { id: 'story', title: 'The long way home', language: 'en', manuscript: sampleManuscript() })
  store.save({ id: 'cuento', title: 'El camino', language: 'es-MX', manuscript: sampleManuscript() })
  store.save({ id: 'histoire', title: 'Le chemin', language: 'fr', manuscript: sampleManuscript() })
  const files = { cover: join(dir, 'cover.png'), garden: join(dir, 'garden.jpg'), pdf: join(dir, 'notes.pdf'), mp3: join(dir, 'rain.mp3') }
  await writeFile(files.cover, png)
  await writeFile(files.garden, jpeg)
  await writeFile(files.pdf, pdf)
  await writeFile(files.mp3, mp3)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, files }
}

test('Tinto drafts, publishes, updates, translates and unpublishes through the module', async t => {
  const { blog, env, clock, call } = site({ hook: 'https://hooks.example/build' })
  const hooks = []
  t.mock.method(globalThis, 'fetch', async (address, init) => {
    const url = String(address)
    if (url === 'https://hooks.example/build') { hooks.push(init.method); return new Response(null, { status: 200 }) }
    return (await blog.fetch(new Request(url, init), env)) ?? new Response('Site page', { status: 404 })
  })
  const { store, files } = await tintoProject(t)
  const client = new SiteClient({ endpoint, key })
  assert.deepEqual(await client.info(), { name: 'Field Notes', categories: [{ id: 'notes', label: 'Notes' }, { id: 'essays', label: 'Essays' }] })
  const publisher = new Publisher(async () => client, () => clock.time)
  const fields = { title: 'The long way home', slug: 'the-long-way-home', summary: 'Mara comes home.', date: '2026-11-21', tags: ['fiction'], category: 'essays' }
  const base = { siteId: 'field-notes', siteName: 'Field Notes', documentId: 'story', headingId: null, fields, cover: null, images: [], attachments: [] }
  const feed = async () => (await (await call('GET', '/api/tinto/feed', { auth: null })).json()).posts

  const draft = await publisher.publish(store, {
    ...base, status: 'draft', cover: { path: files.cover, name: 'cover.png', alt: 'Kitchen window' },
    images: [{ path: files.garden, name: 'garden.jpg', alt: 'Pear tree' }],
    attachments: [{ path: files.pdf, name: 'notes.pdf', title: 'Field notes' }, { path: files.mp3, name: 'rain.mp3', title: 'Rain' }]
  })
  assert.deepEqual(await feed(), [])
  assert.equal(hooks.length, 0)
  assert.deepEqual([...env.TINTO_MEDIA.objects.keys()].map(item => item.split('/')[2]).sort(), ['audio', 'documents', 'images', 'images'])

  // A preview through Tinto shows the draft in the site's design without changing anything.
  const link = await publisher.preview(store, { ...base, status: 'draft', cover: { file: draft.cover.file, alt: 'Kitchen window' }, images: [], attachments: draft.attachments.map(item => ({ file: item.file, title: item.title })) })
  const shown = await (await call('GET', new URL(link).pathname + new URL(link).search, { auth: null })).text()
  assert.match(shown, /<h1 class="post-title">The long way home<\/h1>/)
  assert.match(shown, /<a href="[^"]+">Rain<\/a>/)
  assert.deepEqual(await feed(), [])
  assert.equal(store.post('field-notes', 'story', null).status, 'draft')

  const live = await publisher.publish(store, { ...base, status: 'published', cover: { file: draft.cover.file, alt: 'Kitchen window' }, images: [], attachments: draft.attachments.map(item => ({ file: item.file, title: item.title })) })
  assert.equal(live.url, 'https://blog.example/en/essays/the-long-way-home')
  let posts = await feed()
  assert.deepEqual(posts.map(item => [item.category, item.attachments.map(file => file.title)]), [['essays', ['Field notes', 'Rain']]])
  const served = await call('GET', posts[0].attachments[1].url, { auth: null })
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), mp3)
  assert.deepEqual(store.versions('story').filter(version => version.name).map(version => version.name), ['Released on Field Notes'])
  // The gallery image left the post; it waits an hour in the trash.
  assert.equal(env.TINTO_DB.db.prepare('SELECT COUNT(*) AS n FROM tinto_trash').get().n, 1)

  const spanish = await publisher.publish(store, { ...base, documentId: 'cuento', status: 'published', fields: { ...fields, title: 'El camino', category: 'notes' } })
  assert.equal(spanish.url, 'https://blog.example/castellano/notes/the-long-way-home')
  await assert.rejects(publisher.publish(store, { ...base, documentId: 'histoire', status: 'published' }), /^Error: This site publishes posts in en, es only\.$/)
  await assert.rejects(publisher.publish(store, { ...base, headingId: 'the-kitchen', status: 'published' }), /already uses the address “the-long-way-home”/)

  clock.time += 61 * 60 * 1000
  await publisher.unpublish(store, 'field-notes', 'story', null)
  posts = await feed()
  assert.deepEqual(posts.map(item => [item.locale, item.title]), [['castellano', 'El camino']])
  assert.equal([...env.TINTO_MEDIA.objects.keys()].filter(item => item.includes('/images/')).length, 1, 'the gallery image expired; the cover waits its hour')
  assert.equal(hooks.length, 3)
})

test('the Astro loader stores the feed, waits for a first deployment and keeps live posts on failure', async t => {
  const { blog, env, send } = site()
  await send(post())
  let reply = () => blog.fetch(new Request(endpoint + '/feed'), env)
  t.mock.method(globalThis, 'fetch', async () => reply())
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
  assert.deepEqual([...result.entries.keys()], ['en/notes/first-light'])
  assert.equal(result.entries.get('en/notes/first-light').data.url, 'https://blog.example/en/notes/first-light')
  assert.deepEqual(result.logs, ['info Loaded 1 Tinto post (en 1).'])

  reply = async () => new Response('Page not found', { status: 404 })
  process.env.WORKERS_CI = '1'
  result = await run()
  assert.equal(result.entries.size, 0)
  // The build that deploys the update reads the live protocol 1 feed as it is.
  reply = async () => Response.json({ tinto: 1, name: 'Field Notes', posts: [{ ...post(), id, locale: 'en', category: undefined, status: undefined, attachments: undefined }] })
  result = await run()
  assert.deepEqual([...result.entries.keys()], ['en/first-light'])
  assert.match(result.logs[0], /^warn The live site still runs Tinto blog protocol 1\./)
  reply = async () => Response.json({ tinto: 3, posts: [] })
  await assert.rejects(run(), /uses Tinto blog protocol 3, but this copy of the module uses 2\. Update the module and deploy/)
  reply = async () => new Response('Error', { status: 500 })
  await assert.rejects(run(), /returned HTTP 500\. The build stops so the live site keeps its posts\./)
  delete process.env.WORKERS_CI
  result = await run()
  assert.deepEqual(result.entries.size, 0)

  reply = async () => Response.json({ tinto: 2, posts: [{ ...post(), id, locale: 'en', html: '<img src=x onerror=alert(1)>' }] })
  await assert.rejects(run(), new RegExp('Tinto post ' + id + ': The post body contains markup'))
  reply = async () => Response.json({ tinto: 2, posts: [{ ...post(), id, locale: 'fr' }] })
  await assert.rejects(run(), /locale "fr" is not one of this site's locales/)
})

test('the example configuration is valid and a broken one fails when the module starts', () => {
  assert.doesNotThrow(() => createTintoBlog(exampleConfig))
  const broken = [{ ...config, name: '' }, { ...config, site: 'example.com' }, { ...config, basePath: 'api' }, { ...config, previewPath: 'preview' }, { ...config, previewPath: '/api/tinto' }, { ...config, languages: { english: 'en' } }, { ...config, categories: { 'Not An Id': 'Notes' } }, { ...config, categories: { notes: '' } }]
  for (const value of broken) assert.throws(() => createTintoBlog(value), /tinto\.config\.mjs/)
})
