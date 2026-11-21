import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { postBlocks, verifyCredential, SOURCE_TYPES } from '../modules/cloudflare/credential.mjs'
import { newAuthor } from './author-fixture.mjs'

const bundle = await build({ stdin: { contents: "export * from './src/site-api'; export * from './src/publishing'; export * from './src/storage'; export * from './src/model'; export { postHTML } from './src/exchange'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { SiteClient, Publisher, ProjectStore, changedSinceRelease, postHTML, postId, sampleManuscript, siteId, validateConnection, NO_AUTHOR } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const endpoint = 'https://example.com/tinto'
const key = 'site-key-with-enough-characters'
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cover pixels')])
const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('gallery pixels')])
const pdf = Buffer.from('%PDF-1.7\nfield notes\n%%EOF')
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.from('rain on the window')])
const csv = Buffer.from('date,rain\n2026-11-21,12\n')
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
    if (request.method === 'GET') return Response.json({ tinto: 2, name: ' Field\nnotes ', categories: [{ id: 'notes', label: 'Notes' }, { id: 'Bad Id', label: 'Dropped' }, { id: 'blog', label: '' }] })
    if (request.method === 'DELETE') return Response.json({ error: 'Not found' }, { status: 404 })
    if (String(address).includes('/files/')) return new Response(null, { status: 201 })
    return Response.json(requests.length === 3 ? { url: 'https://example.com/en/first-light', authorship: 'verified' } : { url: 'javascript:alert(1)' })
  })
  const site = new SiteClient({ endpoint, key })
  assert.deepEqual(await site.info(), { name: 'Field notes', categories: [{ id: 'notes', label: 'Notes' }] })
  await site.putFile('post-1', 'abc.pdf', pdf, 'application/pdf')
  const post = {
    slug: 'first-light', language: 'en', category: 'notes', status: 'published', title: 'First light', summary: '', date: '2026-11-21', tags: [],
    html: '<p>Hi</p>', cover: null, images: [], attachments: [{ file: 'abc.pdf', type: 'application/pdf', title: 'Field notes', size: pdf.length }], updatedAt: '2026-11-21T00:00:00.000Z'
  }
  // A module that checks authorship says so; an older one does not.
  assert.deepEqual(await site.putPost('post-1', post), { url: 'https://example.com/en/first-light', verified: true })
  assert.deepEqual(await site.putPost('post-1', post), { url: null, verified: false })
  await site.deletePost('post-1')
  assert.deepEqual(requests.map(({ url, method, auth, accept, redirect }) => [method, url, auth, accept, redirect]), [
    ['GET', endpoint, 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1/files/abc.pdf', 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error'],
    ['PUT', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error'],
    ['DELETE', endpoint + '/posts/post-1', 'Bearer ' + key, 'application/json', 'error']
  ])
  assert.equal(requests[1].type, 'application/pdf')
  assert.deepEqual(Buffer.from(requests[1].body), pdf)
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
    [() => Response.json({ tinto: 3, name: 'Future' }), () => site.info(), /newer version of the Tinto blog module/],
    [() => Response.json({ tinto: 1, name: 'Earlier' }), () => site.info(), /older Tinto blog module\. Update it with Settings → Websites → \? → Save module to your site, then deploy/],
    [() => Response.json({ error: 'Bad key' }, { status: 401 }), () => site.putPost('p', post), /example\.com rejected the API key/],
    [() => Response.json({}, { status: 403 }), () => site.putFile('p', 'a.png', png, 'image/png'), /rejected the API key/],
    [() => Response.json({ error: 'That address is taken.' }, { status: 409 }), () => site.putPost('p', post), /^Error: That address is taken\.$/],
    [() => Response.json({}, { status: 409 }), () => site.putPost('p', post), /already uses this address on example\.com/],
    [() => Response.json({ error: 'Tags\nare too long' }, { status: 422 }), () => site.putPost('p', post), /^Error: Tags are too long$/],
    [() => Response.json({}, { status: 400 }), () => site.putFile('p', 'a.png', png, 'image/png'), /rejected the file/],
    [() => Response.json({}, { status: 413 }), () => site.putFile('p', 'a.png', png, 'image/png'), /does not accept a file this large/],
    [() => Response.json({}, { status: 429 }), () => site.putPost('p', post), /limiting requests/],
    [() => Response.json({ error: 'Database offline' }, { status: 503 }), () => site.deletePost('p'), /returned HTTP 503: Database offline/],
    [() => new Response('Not found', { status: 404 }), () => site.putPreview('p', post), /module without previews\. Update it with Settings → Websites → \?/],
    [() => Response.json({ url: 'https://elsewhere.example/tinto/preview/p' }), () => site.putPreview('p', post), /unexpected preview address/],
    [() => Response.json({ url: 'https://example.com/other/preview/p' }), () => site.putPreview('p', post), /unexpected preview address/],
    [() => { throw TypeError('fetch failed') }, () => site.info(), /Could not reach example\.com.*without redirects/],
    [() => { throw new DOMException('timed out', 'TimeoutError') }, () => site.putPost('p', post), /did not answer in time/]
  ]
  for (const [response, call, error] of cases) {
    reply = response
    await assert.rejects(call(), error)
  }
})

// A website that records what it receives and how many uploads overlap.
class FakeSite {
  log = []
  files = new Map()
  posts = new Map()
  fail = null
  active = 0
  peak = 0
  async putFile(id, file, bytes, type) {
    this.log.push('file ' + file)
    this.active++
    this.peak = Math.max(this.peak, this.active)
    await new Promise(resolve => setTimeout(resolve, 5))
    this.active--
    if (this.fail === 'file') throw Error('example.com rejected the file.')
    this.files.set(id + '/' + file, { bytes: Buffer.from(bytes), type })
  }
  async putPost(id, post) {
    this.log.push('post ' + id)
    if (this.fail === 'post') throw Error('example.com returned HTTP 500.')
    this.posts.set(id, post)
    return { url: post.status === 'published' ? 'https://example.com/posts/' + post.slug : null, verified: true }
  }
  async putPreview(id, post) {
    this.log.push('preview ' + id)
    this.previews = { ...this.previews, [id]: post }
    return { url: 'https://example.com/tinto/preview/' + id + '?expires=1&sig=abc' }
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
  const files = {
    cover: join(dir, 'cover.png'), garden: join(dir, 'garden.jpg'), other: join(dir, 'other.png'), fake: join(dir, 'notes.png'),
    pdf: join(dir, 'Field notes.pdf'), mp3: join(dir, 'rain.mp3'), csv: join(dir, 'rain.csv')
  }
  await writeFile(files.cover, png)
  await writeFile(files.garden, jpeg)
  await writeFile(files.other, Buffer.concat([png, Buffer.from('another')]))
  await writeFile(files.fake, 'plain text')
  await writeFile(files.pdf, pdf)
  await writeFile(files.mp3, mp3)
  await writeFile(files.csv, csv)
  const sites = { one: new FakeSite(), two: new FakeSite() }
  const clock = { time: Date.UTC(2026, 10, 21) }
  const author = await newAuthor()
  const signer = { current: author }
  const publisher = new Publisher(async id => {
    if (!sites[id]) throw Error('This website is no longer in Tinto. Add it again in Settings.')
    return sites[id]
  }, async () => signer.current, () => clock.time)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return {
    sites, publisher, files, document, clock, author, signer,
    get store() { return store },
    reopen() { store.close(); store = new ProjectStore(path) }
  }
}
const fields = { title: 'The kitchen', slug: 'the-kitchen', summary: 'Mara comes home.', date: '2026-11-21', tags: ['fiction', ' home ', 'fiction'], category: 'notes' }
const request = (overrides = {}) => ({ siteId: 'one', siteName: 'Field Notes', documentId: 'story', headingId: 'the-kitchen', status: 'published', fields, cover: null, images: [], attachments: [], ...overrides })

test('publishing uploads new files three at a time, then sends the post, then keeps a release in History', async t => {
  const f = await fixture(t)
  const site = f.sites.one
  const progress = []
  const post = await f.publisher.publish(f.store, request({
    cover: { path: f.files.cover, name: 'cover.png', alt: ' A lit kitchen window ' },
    images: [{ path: f.files.garden, name: 'garden.jpg', alt: 'Pear tree' }, { path: f.files.cover, name: 'cover-again.png', alt: 'Same file' }],
    attachments: [{ path: f.files.pdf, name: 'Field notes.pdf', title: ' Field notes ' }, { path: f.files.mp3, name: 'rain.mp3', title: 'Rain' }, { path: f.files.csv, name: 'rain.csv', title: 'Rain data' }]
  }), (done, total) => progress.push(done + '/' + total))
  assert.equal(post.id, postId(f.store.projectId(), 'one', 'story', 'the-kitchen'))
  assert.match(post.id, uuid)
  assert.match(post.cover.file, /^[0-9a-f]{32}\.png$/)
  assert.deepEqual(post.attachments.map(item => [item.file.slice(33), item.type, item.title, item.size, item.name]), [
    ['pdf', 'application/pdf', 'Field notes', pdf.length, 'Field notes.pdf'], ['mp3', 'audio/mpeg', 'Rain', mp3.length, 'rain.mp3'], ['csv', 'text/csv', 'Rain data', csv.length, 'rain.csv']
  ])
  // Five different files (the cover is chosen twice), sent before the post and never more than three at once.
  assert.equal(site.log.filter(entry => entry.startsWith('file ')).length, 5)
  assert.equal(site.log.at(-1), 'post ' + post.id)
  assert.equal(site.peak, 3)
  assert.deepEqual(progress, ['0/5', '1/5', '2/5', '3/5', '4/5', '5/5'])
  const sent = site.posts.get(post.id)
  assert.deepEqual(Object.keys(sent), ['slug', 'language', 'category', 'status', 'title', 'summary', 'date', 'tags', 'html', 'cover', 'images', 'attachments', 'updatedAt', 'credential'])
  assert.deepEqual([sent.status, sent.category, sent.tags], ['published', 'notes', ['fiction', 'home']])
  assert.deepEqual(sent.attachments[0], { file: post.attachments[0].file, type: 'application/pdf', title: 'Field notes', size: pdf.length })
  assert.match(sent.html, /^<p>The house was quiet/)
  assert.doesNotMatch(JSON.stringify(sent), /cover\.png|garden\.jpg|rain\.mp3|Field notes\.pdf/)

  // The release is a named version that keeps the published text.
  const [release] = f.store.versions('story').filter(version => version.name)
  assert.deepEqual([release.name, release.id], ['Released on Field Notes', post.release.versionId])
  assert.equal(changedSinceRelease(f.store, post), false)
  f.reopen()
  assert.deepEqual(f.store.post('one', 'story', 'the-kitchen'), post)

  // Republishing unchanged files and text sends only the post and keeps the same release.
  site.log = []
  f.clock.time += 60_000
  const again = await f.publisher.publish(f.store, request({ fields: { ...fields, title: 'The kitchen, again' }, cover: { file: post.cover.file, alt: 'Kitchen window' }, attachments: [{ file: post.attachments[0].file, title: 'Notes (PDF)' }] }))
  assert.deepEqual(site.log, ['post ' + post.id])
  assert.equal(again.release.versionId, post.release.versionId)
  assert.equal(again.release.at, f.clock.time)
  assert.equal(again.attachments[0].title, 'Notes (PDF)')
  assert.equal(f.store.versions('story').filter(version => version.name).length, 1)

  // Editing the text marks the post as changed until a new release.
  const changed = f.store.readDocument('story')
  changed.manuscript.content[2].content = [{ type: 'text', text: 'A new first line for the kitchen.' }]
  f.store.save(changed)
  assert.equal(changedSinceRelease(f.store, again), true)
  const next = await f.publisher.publish(f.store, request({ cover: { file: post.cover.file, alt: 'Kitchen window' } }))
  assert.notEqual(next.release.versionId, post.release.versionId)
  assert.equal(changedSinceRelease(f.store, next), false)
  assert.deepEqual(f.store.versions('story').filter(version => version.name).map(version => version.name), ['Released on Field Notes', 'Released on Field Notes'])
})

test('every post is signed by its author, with the text, each paragraph, its files and where each paragraph came from', async t => {
  const f = await fixture(t)
  // The second paragraph of the kitchen was pasted, and part of the third imported.
  const doc = f.store.readDocument('story')
  const pasted = { type: 'origin', attrs: { source: 'pasted' } }
  doc.manuscript.content[1].content = [{ type: 'text', text: 'The house was quiet when Mara arrived.', marks: [pasted] }]
  doc.manuscript.content[3].content = [{ type: 'text', text: '“You always say that,” ' }, { type: 'text', text: 'she said.', marks: [{ type: 'em' }, { type: 'origin', attrs: { source: 'imported' } }] }]
  f.store.save(doc)
  f.store.recordWriting('story', 'typing', { typed: 400, deleted: 20, activeMs: 300_000, intervals: [0, 5, 100, 200, 60, 20, 10, 4] })
  const post = await f.publisher.publish(f.store, request({ cover: { path: f.files.cover, name: 'cover.png', alt: 'Window' }, attachments: [{ path: f.files.pdf, name: 'Field notes.pdf', title: 'Notes' }] }))
  const sent = f.sites.one.posts.get(post.id)
  const { credential } = sent
  assert.deepEqual(await verifyCredential(credential), { verified: true, did: f.author.did })
  assert.deepEqual(credential['@context'], ['https://www.w3.org/ns/credentials/v2'])
  assert.deepEqual(credential.type, ['VerifiableCredential', 'AuthorshipCredential'])
  assert.deepEqual([credential.proof.type, credential.proof.cryptosuite, credential.proof.proofPurpose], ['DataIntegrityProof', 'eddsa-jcs-2022', 'assertionMethod'])
  const subject = credential.credentialSubject
  assert.deepEqual([subject.id, subject.type, subject.name, subject.inLanguage, subject.author], ['urn:uuid:' + post.id, 'CreativeWork', 'The kitchen', 'en', { id: f.author.did, name: f.author.name }])
  assert.equal(subject.sha256, createHash('sha256').update(sent.html).digest('hex'))
  assert.deepEqual(subject.hasPart.map(part => part.sha256), postBlocks(sent.html).map(block => createHash('sha256').update(block).digest('hex')))
  assert.deepEqual(subject.hasPart.map(part => [part.characters.written > 0, part.characters.pasted > 0, part.characters.imported > 0, part.digitalSourceType ?? null]), [
    [false, true, false, null], [true, false, false, SOURCE_TYPES.written], [true, false, true, SOURCE_TYPES.composite], ...subject.hasPart.slice(3).map(() => [true, false, false, SOURCE_TYPES.written])
  ])
  assert.equal(subject.digitalSourceType, SOURCE_TYPES.composite)
  assert.deepEqual(subject.associatedMedia.map(item => item.identifier), [post.cover.file, post.attachments[0].file])
  assert.deepEqual([subject.writingProcess.typedCharacters, subject.writingProcess.activeMinutes, subject.writingProcess.keyIntervals.counts.length, subject.writingProcess.log.intact], [400, 5, 8, true])
  assert.equal(subject.previousCredential, undefined)
  // The origin marks stay in Tinto; the post body has only its formatting.
  assert.doesNotMatch(sent.html, /origin|pasted|imported/)
  assert.match(sent.html, /<em>she said\.<\/em>/)

  // Each later credential points back to the one before it, and a changed text breaks the old signature.
  const again = await f.publisher.publish(f.store, request({ cover: { file: post.cover.file, alt: 'Window' } }))
  assert.deepEqual(f.sites.one.posts.get(post.id).credential.credentialSubject.previousCredential, post.credential)
  assert.notEqual(again.credential.sha256, post.credential.sha256)
  assert.equal(again.verified, true)
  const forged = structuredClone(credential)
  forged.credentialSubject.hasPart[0].characters = { written: 38, pasted: 0, imported: 0, ai: 0 }
  assert.equal((await verifyCredential(forged)).verified, false)

  // Without an author key there is nothing to sign with, so nothing is sent.
  f.signer.current = null
  f.sites.one.log = []
  await assert.rejects(f.publisher.publish(f.store, request()), new RegExp(NO_AUTHOR.slice(0, 30)))
  assert.deepEqual(f.sites.one.log, [])
})

test('a preview uploads the files and sends the post beside the live one, without a local record or release', async t => {
  const f = await fixture(t)
  const progress = []
  const url = await f.publisher.preview(f.store, request({ cover: { path: f.files.cover, name: 'cover.png', alt: 'Window' }, attachments: [{ path: f.files.pdf, name: 'Field notes.pdf', title: 'Notes' }] }), (done, total) => progress.push(done + '/' + total))
  const id = postId(f.store.projectId(), 'one', 'story', 'the-kitchen')
  assert.equal(url, 'https://example.com/tinto/preview/' + id + '?expires=1&sig=abc')
  assert.deepEqual(f.sites.one.log.filter(entry => !entry.startsWith('file ')), ['preview ' + id])
  assert.deepEqual(progress, ['0/2', '1/2', '2/2'])
  assert.equal(f.sites.one.previews[id].title, 'The kitchen')
  assert.equal(f.sites.one.posts.size, 0)
  assert.equal(f.store.post('one', 'story', 'the-kitchen'), null)
  assert.deepEqual(f.store.versions('story').filter(version => version.name), [])
})

test('a draft goes to the website without a release, and publishing it creates one', async t => {
  const f = await fixture(t)
  const draft = await f.publisher.publish(f.store, request({ status: 'draft', cover: { path: f.files.cover, name: 'cover.png', alt: '' } }))
  assert.deepEqual([draft.status, draft.release, draft.url], ['draft', null, null])
  assert.equal(f.sites.one.posts.get(draft.id).status, 'draft')
  assert.deepEqual(f.store.versions('story').filter(version => version.name), [])
  assert.equal(changedSinceRelease(f.store, draft), false)
  const live = await f.publisher.publish(f.store, request({ cover: { file: draft.cover.file, alt: '' } }))
  assert.deepEqual([live.id, live.status, live.url], [draft.id, 'published', 'https://example.com/posts/the-kitchen'])
  assert.ok(live.release)
  const back = await f.publisher.publish(f.store, request({ status: 'draft', cover: { file: draft.cover.file, alt: '' } }))
  assert.equal(back.status, 'draft')
  assert.deepEqual(back.release, live.release)
})

test('a failed attempt changes nothing locally, and the retry updates the same post', async t => {
  const f = await fixture(t)
  const site = f.sites.one
  const input = request({ headingId: null, cover: { path: f.files.cover, name: 'cover.png', alt: '' } })
  for (const failure of ['file', 'post']) {
    site.fail = failure
    await assert.rejects(f.publisher.publish(f.store, input), failure === 'file' ? /rejected the file/ : /HTTP 500/)
    assert.equal(f.store.post('one', 'story', null), null)
  }
  assert.deepEqual(f.store.versions('story').filter(version => version.name), [])
  site.fail = null
  const post = await f.publisher.publish(f.store, input)
  assert.deepEqual(new Set(site.log.filter(entry => entry.startsWith('post ')).map(entry => entry.slice(5))), new Set([post.id]))

  site.fail = 'post'
  await assert.rejects(f.publisher.publish(f.store, { ...input, fields: { ...fields, title: 'Changed' }, cover: { file: post.cover.file, alt: '' } }), /HTTP 500/)
  assert.deepEqual(f.store.post('one', 'story', null), post)
  site.fail = null
  await assert.rejects(f.publisher.publish(f.store, { ...input, siteId: 'removed' }), /no longer in Tinto/)
})

test('each website keeps its own post of the same document, and unpublishing touches only one', async t => {
  const f = await fixture(t)
  const input = request({ headingId: null, cover: { path: f.files.cover, name: 'cover.png', alt: '' } })
  const first = await f.publisher.publish(f.store, input)
  const second = await f.publisher.publish(f.store, { ...input, siteId: 'two', siteName: 'Second', fields: { ...fields, slug: 'kitchen', category: '' } })
  assert.notEqual(first.id, second.id)
  assert.deepEqual(f.store.posts('story', null).map(post => [post.siteId, post.slug, post.category]), [['one', 'the-kitchen', 'notes'], ['two', 'kitchen', '']])
  assert.deepEqual(f.store.allPosts().map(post => post.siteId), ['one', 'two'])
  await f.publisher.unpublish(f.store, 'one', 'story', null)
  assert.equal(f.sites.one.posts.size, 0)
  assert.deepEqual(f.store.posts('story', null).map(post => post.id), [second.id])
  const back = await f.publisher.publish(f.store, input)
  assert.equal(back.id, first.id)
})

test('an invalid post or file sends nothing to the website', async t => {
  const f = await fixture(t)
  const input = request({ headingId: null })
  const invalid = [
    [{ ...input, fields: { ...fields, slug: 'The Kitchen!' } }, /lowercase letters/],
    [{ ...input, fields: { ...fields, date: '2026-02-30' } }, /valid post date/],
    [{ ...input, fields: { ...fields, title: '   ' } }, /title/],
    [{ ...input, fields: { ...fields, category: 'Not An Id' } }, /website’s categories/],
    [{ ...input, cover: { path: f.files.fake, name: 'notes.png', alt: '' } }, /notes\.png is not a file type a post can include/],
    [{ ...input, cover: { path: f.files.pdf, name: 'Field notes.pdf', alt: '' } }, /is not an image/],
    [{ ...input, attachments: [{ path: f.files.garden, name: 'garden.jpg', title: 'Garden' }] }, /is an image\. Add it to the gallery/],
    [{ ...input, attachments: [{ path: f.files.pdf, name: 'Field notes.pdf', title: '  ' }] }, /title of up to 120/],
    [{ ...input, cover: { file: 'secret.png', alt: '' } }, /no longer part of this post/],
    [{ ...input, images: Array.from({ length: 31 }, () => ({ path: f.files.cover, name: 'cover.png', alt: '' })) }, /up to 30 files/],
    [{ ...input, headingId: 'missing' }, /no longer in its document/]
  ]
  for (const [bad, error] of invalid) await assert.rejects(f.publisher.publish(f.store, bad), error)
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
  assert.match(html, /<h2><u><strong>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; <\/strong><\/u><\/h2>$/)
})
