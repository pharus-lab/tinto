import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const sites = [
  { url: 'https://one.example/tinto/', endpoint: 'https://one.example/tinto', key: 'key-for-the-first-website-0001', name: 'Field Notes', categories: [{ id: 'notes', label: 'Notes' }, { id: 'essays', label: 'Essays' }] },
  { url: 'https://two.example/api/tinto', endpoint: 'https://two.example/api/tinto', key: 'key-for-the-second-website-002', name: 'Second Site', categories: [] }
]

// The main process talks to two simulated websites and an in-memory keychain.
async function simulateWebsites(app, files) {
  await app.evaluate(({ safeStorage, dialog, shell }, { files, sites }) => {
    safeStorage.isAsyncEncryptionAvailable = async () => true
    if (process.platform === 'linux') safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret'
    safeStorage.encryptStringAsync = async text => Buffer.from('sealed:' + text)
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false })
    globalThis.picks = []
    dialog.showOpenDialog = async (window, options) => ({ canceled: false, filePaths: [globalThis.picks.shift() ?? (options.title.includes('cover') ? files.cover : files.pdf)] })
    globalThis.siteRequests = []
    globalThis.opened = []
    shell.openExternal = async url => { globalThis.opened.push(url) }
    globalThis.fetch = async (address, init = {}) => {
      const url = String(address)
      const headers = new Headers(init.headers)
      globalThis.siteRequests.push({ url, method: init.method, auth: headers.get('Authorization'), type: headers.get('Content-Type'), redirect: init.redirect, body: typeof init.body === 'string' ? init.body : init.body?.byteLength ?? null })
      const site = sites.find(item => url === item.endpoint || url.startsWith(item.endpoint + '/'))
      if (!site || headers.get('Authorization') !== 'Bearer ' + site.key) return Response.json({ error: 'Unknown key' }, { status: 401 })
      if (init.method === 'GET') return Response.json({ tinto: 2, name: site.name, categories: site.categories })
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/files/')) return new Response(null, { status: 201 })
      if (url.includes('/previews/')) return Response.json({ url: url.replace('/previews/', '/preview/') + '?expires=1&sig=abc' })
      const post = JSON.parse(init.body)
      return Response.json({ url: post.status === 'published' ? new URL(site.endpoint).origin + '/' + (post.category || 'posts') + '/' + post.slug : null, authorship: post.credential ? 'verified' : null })
    }
  }, { files, sites })
}
async function requests(app) {
  const list = await app.evaluate(() => globalThis.siteRequests.splice(0))
  for (const request of list) assert.equal(request.redirect, 'error')
  return list.map(({ url, method, auth, type, body }) => {
    const site = sites.find(item => auth === 'Bearer ' + item.key)
    const path = url.replace(/\/(posts|previews)\/[0-9a-f-]{36}/, '/$1/<post>').replace(/[0-9a-f]{32}\.(png|pdf)$/, '<hash>.$1')
    return { request: method + ' ' + path, key: site?.name ?? null, type, body }
  })
}

test('a writer publishes to one website by category, drafts on another, sees changes since the release, lists all posts and unpublishes', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const files = { cover: join(fixture.directory, 'cover.png'), pdf: join(fixture.directory, 'Field notes.pdf') }
  await writeFile(files.cover, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('kitchen window')]))
  await writeFile(files.pdf, Buffer.from('%PDF-1.7\nfield notes\n%%EOF'))
  await simulateWebsites(fixture.app, files)
  const modal = page.getByRole('dialog')
  const status = modal.locator('.publish-status')

  await page.locator('#publish').click()
  await modal.getByText('Add a website in Settings').waitFor()
  await button(modal, 'Open Settings').click()
  // Publish opens Settings at Websites.
  assert.equal(await modal.getByRole('tab', { name: 'Websites' }).getAttribute('aria-selected'), 'true')
  for (const site of sites) {
    await modal.getByLabel('Publishing URL', { exact: true }).fill(site.url)
    await modal.getByLabel('API key', { exact: true }).fill(site.key)
    await button(modal, 'Add website').click()
    await modal.getByText('Connected ' + site.name + '. The website accepted the API key.').waitFor()
  }
  assert.deepEqual(await modal.locator('.site-row').allInnerTexts(), sites.map(site => site.name + '\n' + site.endpoint + '\nTest\nRemove'))
  assert.deepEqual((await requests(fixture.app)).map(item => item.request), sites.map(site => 'GET ' + site.endpoint))
  await button(modal, 'Close dialog').click()

  // Field Notes offers its categories; the post goes to Essays with a cover and a PDF.
  await page.locator('#publish').click()
  assert.deepEqual(await modal.getByLabel('Category', { exact: true }).locator('option').allInnerTexts(), ['Notes', 'Essays'])
  await modal.getByLabel('Category', { exact: true }).selectOption({ label: 'Essays' })
  await modal.getByLabel('Title', { exact: true }).fill('El largo camino a casa')
  await modal.getByLabel('Summary', { exact: true }).fill('Mara comes home in the rain.')
  await button(modal, 'Choose cover').click()
  await modal.getByLabel('Description of cover.png').fill('The kitchen window at night')
  await button(modal, 'Attach files').click()
  assert.equal(await modal.getByLabel('Title of Field notes.pdf').inputValue(), 'Field notes')
  // Every post is signed; the first time, Tinto asks for the author's name.
  assert.equal(await modal.locator('.publish-authorship').innerText(), 'Original · written in Tinto')
  await modal.getByLabel('Sign as', { exact: true }).fill('Mara Ruiz')

  // Preview sends the post beside anything live and opens the site's link in the browser.
  await button(modal, 'Preview').click()
  await status.getByText('Opened the preview of Field Notes in your browser. The link works for one hour.').waitFor()
  const opened = await fixture.app.evaluate(() => globalThis.opened)
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^https:\/\/one\.example\/tinto\/preview\/[0-9a-f-]{36}\?expires=1&sig=abc$/)
  const previewed = await requests(fixture.app)
  assert.equal(previewed.at(-1).request, 'PUT https://one.example/tinto/previews/<post>')
  assert.equal(JSON.parse(previewed.at(-1).body).title, 'El largo camino a casa')
  assert.match(await status.innerText(), /Opened the preview/)
  const author = await page.evaluate(() => window.tinto.author())
  assert.equal(author.name, 'Mara Ruiz')
  assert.match(author.did, /^did:key:z6Mk/)
  assert.equal(JSON.parse(previewed.at(-1).body).credential.issuer.id, author.did)
  assert.equal(await modal.getByLabel('Sign as', { exact: true }).count(), 0)
  assert.equal(await modal.locator('.publish-authorship').innerText(), 'Original · written in Tinto · signed as Mara Ruiz')
  await button(modal, 'Publish').click()
  await page.locator('#notice').getByText('Published “El largo camino a casa” on Field Notes.').waitFor()
  const first = await requests(fixture.app)
  assert.deepEqual(first.slice(0, 2).map(item => item.request + ' ' + item.type).sort(), [
    'PUT https://one.example/tinto/posts/<post>/files/<hash>.pdf application/pdf',
    'PUT https://one.example/tinto/posts/<post>/files/<hash>.png image/png'
  ])
  assert.equal(first[2].request, 'PUT https://one.example/tinto/posts/<post>')
  const sent = JSON.parse(first[2].body)
  assert.deepEqual([sent.category, sent.status, sent.cover.alt, sent.attachments.map(item => [item.type, item.title])], ['essays', 'published', 'The kitchen window at night', [['application/pdf', 'Field notes']]])
  assert.deepEqual([sent.credential.credentialSubject.author.name, sent.credential.credentialSubject.associatedMedia.length], ['Mara Ruiz', 2])
  assert.doesNotMatch(first[2].body, /cover\.png|Field notes\.pdf/)

  // The release is a named version in History.
  const releases = await page.evaluate(async () => {
    const workspace = await window.tinto.workspace()
    return (await window.tinto.versions(workspace.project.documents[0].id)).filter(version => version.name).map(version => version.name)
  })
  assert.deepEqual(releases, ['Released on Field Notes'])

  // A draft on the second website uploads its files but stays off its pages.
  await page.locator('#publish').click()
  await modal.getByRole('heading', { name: 'Update post' }).waitFor()
  assert.deepEqual(await modal.getByLabel('Website', { exact: true }).locator('option').allInnerTexts(), ['Field Notes · published', 'Second Site'])
  await modal.getByLabel('Website', { exact: true }).selectOption({ label: 'Second Site' })
  assert.equal(await status.innerText(), 'Not on Second Site yet.')
  assert.equal(await modal.getByLabel('Category', { exact: true }).count(), 0)
  await button(modal, 'Save draft').click()
  await page.locator('#notice').getByText('Saved “El largo camino a casa” as a draft on Second Site.').waitFor()
  const draft = await requests(fixture.app)
  assert.deepEqual(draft.map(item => item.request), ['PUT https://two.example/api/tinto/posts/<post>'])
  assert.equal(JSON.parse(draft[0].body).status, 'draft')

  // Editing the text after a release shows on the published post.
  await page.locator('.ProseMirror:visible p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' The kettle was still warm.')
  await page.locator('#publish').click()
  assert.match(await status.innerText(), /^Draft on Second Site · saved .* · Not public yet$/)
  await modal.getByLabel('Website', { exact: true }).selectOption({ label: 'Field Notes · published' })
  assert.match(await status.innerText(), /^Published on Field Notes · .* · https:\/\/one\.example\/essays\/el-largo-camino-a-casa · Changed since the release$/)

  // All posts groups them by website and category.
  await button(modal, 'All posts').click()
  await modal.getByRole('heading', { name: 'Posts' }).waitFor()
  assert.deepEqual(await modal.locator('.posts-site h3').allInnerTexts(), ['Field Notes', 'Second Site'])
  assert.deepEqual(await modal.locator('.posts-site h4').allInnerTexts(), ['Essays'])
  assert.deepEqual(await modal.locator('.posts-state').allInnerTexts(), ['Changed since the release', 'Draft'])
  await modal.getByRole('button', { name: 'Open El largo camino a casa' }).first().click()
  await modal.waitFor({ state: 'hidden' })

  await page.locator('#publish').click()
  await modal.getByLabel('Website', { exact: true }).selectOption({ label: 'Field Notes · published' })
  await button(modal, 'Unpublish').click()
  await button(modal, 'Remove from site').click()
  await page.locator('#notice').getByText('Removed “El largo camino a casa” from Field Notes.').waitFor()
  assert.deepEqual((await requests(fixture.app)).map(item => item.request + ' ' + item.key), ['DELETE https://one.example/tinto/posts/<post> Field Notes'])

  await page.locator('#settings').click()
  await modal.getByRole('tab', { name: 'Websites' }).click()
  await modal.getByRole('button', { name: 'Test Field Notes' }).click()
  await modal.getByText('Field Notes accepted the API key.').waitFor()
  await modal.getByRole('button', { name: 'Remove Second Site' }).click()
  await modal.getByText('Removed Second Site and its API key from Tinto. Its posts stay on the website.').waitFor()
  const stored = JSON.parse((await readFile(join(fixture.profile, 'sites.enc'), 'utf8')).replace(/^sealed:/, ''))
  assert.deepEqual(stored.map(({ name, endpoint, key, categories }) => ({ name, endpoint, key, categories })), [{ name: 'Field Notes', endpoint: sites[0].endpoint, key: sites[0].key, categories: sites[0].categories }])
})
