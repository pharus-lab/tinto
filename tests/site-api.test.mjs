import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './src/site-api'; export * from './src/publishing'; export * from './src/storage'; export * from './src/model'; export { postHTML } from './src/exchange'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { SiteClient, Publisher, ProjectStore, postHTML, postId, sampleManuscript, siteId, validateConnection } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const endpoint = 'https://example.com/tinto'
const key = 'site-key-with-enough-characters'
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cover pixels')])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('gallery pixels')])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('a website is added with an https publishing URL and its complete API key', () => {
  assert.deepEqual(validateConnection({ endpoint: ' https://Example.com/tinto/ ', key: ' ' + key + ' ' }), { endpoint, key })
  assert.equal(validateConnection({ endpoint: 'https://example.com', key }).endpoint, 'https://example.com')
  for (const local of ['http://localhost:8787/tinto', 'http://127.0.0.1:8787', 'http://[::1]:8787/tinto']) {
    assert.equal(validateConnection({ endpoint: local, key }).endpoint, local)
  }
  for (const rejected of ['http://example.com/tinto', 'https://user:secret@example.com/tinto', endpoint + '?key=1', endpoint + '#top', 'https://example.com/?', 'ftp://example.com/tinto', 'example.com/tinto', '']) {
    assert.throws(() => validateConnection({ endpoint: rejected, key }), /publishing URL/, rejected)
  }
  for (const rejected of ['short', 'has spaces inside the key value', 'x'.repeat(513)]) {
    assert.throws(() => validateConnection({ endpoint, key: rejected }), /API key/)
  }
  assert.match(siteId(endpoint), /^[0-9a-f]{32}$/)
  assert.equal(siteId(validateConnection({ endpoint: 'https://EXAMPLE.com/tinto/', key }).endpoint), siteId(endpoint))
  assert.notEqual(siteId('https://example.org/tinto'), siteId(endpoint))
})

test('every request carries the key to the publishing URL only and refuses redirects', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (address, request) => {
    const headers = request.headers
    requests.push({ url: String(address), method: request.method, auth: headers.get('Authorization'), accept: headers.get('Accept'), type: headers.get('Content-Type'), redirect: request.redirect, body: request.body })
    if (request.method === 'GET') return Response.json({ tinto: 1, name: ' Field\nnotes ' })
    if (request.method === 'DELETE') return Response.json({ error: 'Not found' }, { status: 404 })
    if (String(address).includes('/images/')) return new Response(null, { status: 201 })
    return Response.json({ url: requests.length === 3 ? 'https://example.com/en/first-light' : 'javascript:alert(1)' })
  })
  const site = new SiteClient({ endpoint, key })
  assert.deepEqual(await site.info(), { name: 'Field notes' })
  await site.putImage('post-1', 'abc.png', png, 'image/png')
  const post = { slug: 'first-light', language: 'en', title: 'First light', summary: '', date: '2026-11-21', tags: [], html: '<p>Hi</p>', cover: null, images: [], updatedAt: '2026-11-21T00:00:00.000Z' }
  assert.deepEqual(await site.putPost('post-1', post), { url: 'https://example.com/en/first-light' })
  assert.deepEqual(await site.putPost('post-1', post), { url: null })
  await site.deletePost('post-1')
  assert.deepEqual(requests.map(({ url, method, auth, accept, redirect }) => [method, url, auth, accept, redirect]), [
    ['GET', endpoint, 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1/images/abc.png', 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error'],
    ['DELETE', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error']
  ])
  assert.equal(requests[1].type, 'image/png')
  assert.deepEqual(Buffer.from(requests[1].body), png)
  assert.equal(requests[2].type, 'application/json')
  assert.deepEqual(JSON.parse(requests[2].body), post)
})

test('website failures explain what to do, using the site message where it has one', async t => {
  let reply
  t.mock.method(globalThis, 'fetch', async () => reply())
  const site = new SiteClient({ endpoint, key })
  const post = { slug: 'a' }
  const cases = [
    [() => new Response('Not here', { status: 404 }), () => site.info(), /no Tinto blog module at this publishing URL/],
    [() => Response.json({ hello: 'world' }), () => site.info(), /no Tinto blog module/],
    [() => Response.json({ tinto: 2, name: 'Future' }), () => site.info(), /newer version of the Tinto blog module/],
    [() => Response.json({ error: 'Bad key' }, { status: 401 }), () => site.putPost('p', post), /example\.com rejected the API key/],
    [() => Response.json({}, { status: 403 }), () => site.putImage('p', 'a.png', png, 'image/png'), /rejected the API key/],
    [() => Response.json({ error: 'That address is taken.' }, { status: 409 }), () => site.putPost('p', post), /^Error: That address is taken\.$/],
    [() => Response.json({}, { status: 409 }), () => site.putPost('p', post), /already uses this address on example\.com/],
    [() => Response.json({ error: 'Tags\nare too long' }, { status: 422 }), () => site.putPost('p', post), /^Error: Tags are too long$/],
    [() => Response.json({}, { status: 400 }), () => site.putImage('p', 'a.png', png, 'image/png'), /rejected the image/],
    [() => Response.json({}, { status: 413 }), () => site.putImage('p', 'a.png', png, 'image/png'), /does not accept an image this large/],
    [() => Response.json({}, { status: 429 }), () => site.putPost('p', post), /limiting requests/],
    [() => Response.json({ error: 'Database offline' }, { status: 503 }), () => site.deletePost('p'), /returned HTTP 503: Database offline/],
    [() => { throw TypeError('fetch failed') }, () => site.info(), /Could not reach example\.com.*without redirects/],
    [() => { throw new DOMException('timed out', 'TimeoutError') }, () => site.putPost('p', post), /did not answer in time/]
  ]
  for (const [response, call, error] of cases) {
    reply = response
    await assert.rejects(call(), error)
  }
})

class FakeSite {
  log = []
  images = new Map()
  posts = new Map()
  fail = null
  async putImage(id, file, bytes, type) {
    this.log.push('image ' + file)
    if (this.fail === 'image') throw Error('example.com rejected the image.')
    this.images.set(id + '/' + file, { bytes: Buffer.from(bytes), type })
  }
  async putPost(id, post) {
    this.log.push('post ' + id)
    if (this.fail === 'post') throw Error('example.com returned HTTP 500.')
    this.posts.set(id, post)
    return { url: 'https://example.com/posts/' + post.slug }
  }
  async deletePost(id) {
    this.log.push('delete ' + id)
    this.posts.delete(id)
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
  const sites = { one: new FakeSite(), two: new FakeSite() }
  const publisher = new Publisher(async id => {
    if (!sites[id]) throw Error('This website is no longer in Tinto. Add it again in Settings.')
    return sites[id]
  }, () => Date.UTC(2026, 10, 21))
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return {
    sites, publisher, files, document,
    get store() { return store },
    reopen() { store.close(); store = new ProjectStore(path) }
  }
}
const fields = { title: 'The kitchen', slug: 'the-kitchen', summary: 'Mara comes home.', date: '2026-11-21', tags: ['fiction', ' home ', 'fiction'] }

test('publishing uploads new images, then sends the post, then keeps the record for that website', async t => {
  const f = await fixture(t)
  const site = f.sites.one
  const post = await f.publisher.publish(f.store, {
    siteId: 'one', documentId: 'story', headingId: 'the-kitchen', fields,
    cover: { path: f.files.cover, name: 'cover.png', alt: ' A lit kitchen window ' },
    images: [{ path: f.files.garden, name: 'garden.jpg', alt: 'Pear tree' }, { path: f.files.cover, name: 'cover-again.png', alt: 'Same file' }]
  })
  assert.equal(post.id, postId(f.store.projectId(), 'one', 'story', 'the-kitchen'))
  assert.match(post.id, uuid)
  assert.match(post.cover.file, /^[0-9a-f]{32}\.png$/)
  assert.match(post.images[0].file, /^[0-9a-f]{32}\.jpg$/)
  assert.deepEqual(site.log, ['image ' + post.cover.file, 'image ' + post.images[0].file, 'post ' + post.id])
  const sent = site.posts.get(post.id)
  assert.deepEqual(Object.keys(sent), ['slug', 'language', 'title', 'summary', 'date', 'tags', 'html', 'cover', 'images', 'updatedAt'])
  assert.deepEqual({ ...sent, html: undefined }, {
    slug: 'the-kitchen', language: 'en', title: 'The kitchen', summary: 'Mara comes home.', date: '2026-11-21', tags: ['fiction', 'home'], html: undefined,
    cover: { file: post.cover.file, type: 'image/png', alt: 'A lit kitchen window' },
    images: [{ file: post.images[0].file, type: 'image/jpeg', alt: 'Pear tree' }, { file: post.cover.file, type: 'image/png', alt: 'Same file' }],
    updatedAt: '2026-11-21T00:00:00.000Z'
  })
  assert.match(sent.html, /^<p>The house was quiet/)
  assert.doesNotMatch(sent.html, /<h1>|The garden|a cat/)
  assert.doesNotMatch(JSON.stringify(sent), /cover\.png|garden\.jpg/)
  assert.equal(site.images.get(post.id + '/' + post.cover.file).type, 'image/png')
  assert.equal(post.url, 'https://example.com/posts/the-kitchen')
  f.reopen()
  assert.deepEqual(f.store.post('one', 'story', 'the-kitchen'), post)
  assert.deepEqual(f.store.posts('story', 'the-kitchen'), [post])
  assert.equal(f.store.post('two', 'story', 'the-kitchen'), null)
  assert.equal(f.store.post('one', 'story', null), null)

  // Republishing images the website already has sends only the post.
  site.log = []
  const again = await f.publisher.publish(f.store, {
    siteId: 'one', documentId: 'story', headingId: 'the-kitchen', fields: { ...fields, title: 'The kitchen, again' },
    cover: { file: post.cover.file, alt: 'Kitchen window' }, images: [{ path: f.files.garden, name: 'garden copy.jpg', alt: '' }]
  })
  assert.deepEqual(site.log, ['post ' + post.id])
  assert.equal(again.id, post.id)
  assert.equal(again.cover.alt, 'Kitchen window')
  assert.equal(site.posts.get(post.id).title, 'The kitchen, again')
})

test('a failed attempt changes nothing locally, and the retry updates the same post', async t => {
  const f = await fixture(t)
  const site = f.sites.one
  const input = { siteId: 'one', documentId: 'story', headingId: null, fields, cover: { path: f.files.cover, name: 'cover.png', alt: '' }, images: [] }
  for (const failure of ['image', 'post']) {
    site.fail = failure
    await assert.rejects(f.publisher.publish(f.store, input), failure === 'image' ? /rejected the image/ : /HTTP 500/)
    assert.equal(f.store.post('one', 'story', null), null)
  }
  site.fail = null
  const post = await f.publisher.publish(f.store, input)
  assert.deepEqual(new Set(site.log.filter(entry => entry.startsWith('post ')).map(entry => entry.slice(5))), new Set([post.id]))
  assert.deepEqual([...site.posts.keys()], [post.id])

  site.fail = 'post'
  await assert.rejects(f.publisher.publish(f.store, { ...input, fields: { ...fields, title: 'Changed' }, cover: { file: post.cover.file, alt: '' } }), /HTTP 500/)
  assert.deepEqual(f.store.post('one', 'story', null), post)
  site.fail = null
  await assert.rejects(f.publisher.publish(f.store, { ...input, siteId: 'removed' }), /no longer in Tinto/)
  assert.equal(f.store.post('removed', 'story', null), null)
})

test('each website keeps its own post of the same document, and unpublishing touches only one', async t => {
  const f = await fixture(t)
  const input = { documentId: 'story', headingId: null, fields, cover: { path: f.files.cover, name: 'cover.png', alt: '' }, images: [] }
  const first = await f.publisher.publish(f.store, { ...input, siteId: 'one' })
  const second = await f.publisher.publish(f.store, { ...input, siteId: 'two', fields: { ...fields, slug: 'kitchen' } })
  assert.notEqual(first.id, second.id)
  assert.deepEqual(f.sites.two.log, ['image ' + second.cover.file, 'post ' + second.id])
  assert.deepEqual(f.store.posts('story', null).map(post => [post.siteId, post.slug]), [['one', 'the-kitchen'], ['two', 'kitchen']])

  await f.publisher.unpublish(f.store, 'one', 'story', null)
  assert.deepEqual(f.sites.one.log.at(-1), 'delete ' + first.id)
  assert.equal(f.sites.one.posts.size, 0)
  assert.deepEqual(f.store.posts('story', null), [second])
  await f.publisher.unpublish(f.store, 'one', 'story', null)
  assert.equal(f.sites.one.log.filter(entry => entry.startsWith('delete')).length, 1)

  // Publishing there again reuses the same post id.
  const back = await f.publisher.publish(f.store, { ...input, siteId: 'one' })
  assert.equal(back.id, first.id)
})

test('an invalid post or image sends nothing to the website', async t => {
  const f = await fixture(t)
  const input = { siteId: 'one', documentId: 'story', headingId: null, fields, cover: null, images: [] }
  const invalid = [
    [{ ...input, fields: { ...fields, slug: 'The Kitchen!' } }, /lowercase letters/],
    [{ ...input, fields: { ...fields, date: '2026-02-30' } }, /valid post date/],
    [{ ...input, fields: { ...fields, title: '   ' } }, /title/],
    [{ ...input, cover: { path: f.files.fake, name: 'notes.png', alt: '' } }, /notes\.png is not a PNG/],
    [{ ...input, cover: { file: 'secret.png', alt: '' } }, /no longer part of this post/],
    [{ ...input, images: Array.from({ length: 21 }, () => ({ path: f.files.cover, name: 'cover.png', alt: '' })) }, /up to 20 images/],
    [{ ...input, headingId: 'missing' }, /no longer in its document/]
  ]
  for (const [request, error] of invalid) await assert.rejects(f.publisher.publish(f.store, request), error)
  f.store.save({ ...f.document, manuscript: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'empty' } }] } })
  await assert.rejects(f.publisher.publish(f.store, input), /Write some text/)
  assert.deepEqual(f.sites.one.log, [])
  assert.deepEqual(f.store.posts('story', null), [])
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
