import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const sites = [
  { url: 'https://one.example/tinto/', endpoint: 'https://one.example/tinto', key: 'key-for-the-first-website-0001', name: 'Field Notes' },
  { url: 'https://two.example/api/tinto', endpoint: 'https://two.example/api/tinto', key: 'key-for-the-second-website-002', name: 'Second Site' }
]

// The main process talks to two simulated websites and an in-memory keychain.
async function simulateWebsites(app, image) {
  await app.evaluate(({ safeStorage, dialog }, { image, sites }) => {
    safeStorage.isAsyncEncryptionAvailable = async () => true
    safeStorage.encryptStringAsync = async text => Buffer.from('sealed:' + text)
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] })
    globalThis.siteRequests = []
    globalThis.fetch = async (address, init = {}) => {
      const url = String(address)
      const headers = new Headers(init.headers)
      globalThis.siteRequests.push({ url, method: init.method, auth: headers.get('Authorization'), type: headers.get('Content-Type'), redirect: init.redirect, body: typeof init.body === 'string' ? init.body : init.body?.byteLength ?? null })
      const site = sites.find(item => url === item.endpoint || url.startsWith(item.endpoint + '/'))
      if (!site || headers.get('Authorization') !== 'Bearer ' + site.key) return Response.json({ error: 'Unknown key' }, { status: 401 })
      if (init.method === 'GET') return Response.json({ tinto: 1, name: site.name })
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/images/')) return new Response(null, { status: 201 })
      return Response.json({ url: new URL(site.endpoint).origin + '/posts/' + JSON.parse(init.body).slug })
    }
  }, { image, sites })
}
async function requests(app) {
  const list = await app.evaluate(() => globalThis.siteRequests.splice(0))
  for (const request of list) assert.equal(request.redirect, 'error')
  return list.map(({ url, method, auth, type, body }) => {
    const site = sites.find(item => auth === 'Bearer ' + item.key)
    const path = url.replace(/\/posts\/[0-9a-f-]{36}/, '/posts/<post>').replace(/[0-9a-f]{32}\.png$/, '<hash>.png')
    return { request: method + ' ' + path, key: site?.name ?? null, type, body }
  })
}

test('a writer adds two websites, publishes a document to each, unpublishes from one and removes the other', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const image = join(fixture.directory, 'cover.png')
  await writeFile(image, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('kitchen window')]))
  await simulateWebsites(fixture.app, image)
  const modal = page.getByRole('dialog')
  const status = modal.locator('.publish-status')

  await page.locator('#publish').click()
  await modal.getByText('Add a website in Settings').waitFor()
  await button(modal, 'Open Settings').click()
  for (const site of sites) {
    await modal.getByLabel('Publishing URL', { exact: true }).fill(site.url)
    await modal.getByLabel('API key', { exact: true }).fill(site.key)
    await button(modal, 'Add website').click()
    await modal.getByText('Connected ' + site.name + '. The website accepted the API key.').waitFor()
  }
  assert.deepEqual(await modal.locator('.site-row').allInnerTexts(), sites.map(site => site.name + '\n' + site.endpoint + '\nTest\nRemove'))
  assert.equal(await modal.getByLabel('API key', { exact: true }).inputValue(), '')
  assert.deepEqual(await requests(fixture.app), sites.map(site => ({ request: 'GET ' + site.endpoint, key: site.name, type: null, body: null })))
  await button(modal, 'Close dialog').click()

  await page.locator('#publish').click()
  assert.equal(await modal.getByLabel('Website', { exact: true }).inputValue(), await modal.locator('option', { hasText: 'Field Notes' }).getAttribute('value'))
  assert.equal(await modal.getByLabel('Title', { exact: true }).inputValue(), 'The long way home')
  await modal.getByLabel('Title', { exact: true }).fill('El largo camino a casa')
  assert.equal(await modal.getByLabel('Address', { exact: true }).inputValue(), 'el-largo-camino-a-casa')
  await modal.getByLabel('Summary', { exact: true }).fill('Mara comes home in the rain.')
  await button(modal, 'Choose cover').click()
  await modal.getByLabel('Description of cover.png').fill('The kitchen window at night')
  await button(modal, 'Publish').click()
  await page.locator('#notice').getByText('Published “El largo camino a casa” on Field Notes.').waitFor()
  const first = await requests(fixture.app)
  assert.deepEqual(first.map(({ request, key, type }) => [request, key, type]), [
    ['PUT https://one.example/tinto/posts/<post>/images/<hash>.png', 'Field Notes', 'image/png'],
    ['PUT https://one.example/tinto/posts/<post>', 'Field Notes', 'application/json']
  ])
  const sent = JSON.parse(first[1].body)
  assert.deepEqual({ ...sent, html: undefined, updatedAt: undefined, date: undefined, cover: { ...sent.cover, file: undefined } }, {
    slug: 'el-largo-camino-a-casa', language: 'en', title: 'El largo camino a casa', summary: 'Mara comes home in the rain.', tags: [], images: [],
    html: undefined, updatedAt: undefined, date: undefined, cover: { file: undefined, type: 'image/png', alt: 'The kitchen window at night' }
  })
  assert.doesNotMatch(first[1].body, /cover\.png/)

  await page.locator('#publish').click()
  await modal.getByRole('heading', { name: 'Update post' }).waitFor()
  assert.match(await status.innerText(), /^Published on Field Notes · .* · https:\/\/one\.example\/posts\/el-largo-camino-a-casa$/)
  assert.deepEqual(await modal.locator('option').allInnerTexts(), ['Field Notes · published', 'Second Site'])
  assert.equal(await modal.getByLabel('Description of cover.png').inputValue(), 'The kitchen window at night')

  // A second website starts from the same text but needs its own images.
  await modal.getByLabel('Website', { exact: true }).selectOption({ label: 'Second Site' })
  await modal.getByRole('heading', { name: 'Publish' }).waitFor()
  assert.equal(await status.innerText(), 'Not published on Second Site yet.')
  assert.equal(await modal.getByLabel('Title', { exact: true }).inputValue(), 'El largo camino a casa')
  assert.equal(await modal.getByLabel('Summary', { exact: true }).inputValue(), 'Mara comes home in the rain.')
  await button(modal, 'Choose cover').waitFor()
  await button(modal, 'Publish').click()
  await page.locator('#notice').getByText('Published “El largo camino a casa” on Second Site.').waitFor()
  const second = await requests(fixture.app)
  assert.deepEqual(second.map(({ request, key }) => [request, key]), [['PUT https://two.example/api/tinto/posts/<post>', 'Second Site']])
  assert.equal(JSON.parse(second[0].body).cover, null)

  await page.locator('#publish').click()
  assert.match(await status.innerText(), /^Published on Second Site · /)
  await modal.getByLabel('Website', { exact: true }).selectOption({ label: 'Field Notes · published' })
  await button(modal, 'Unpublish').click()
  assert.equal(await status.innerText(), 'Remove this post from Field Notes? The document stays in Tinto.')
  await button(modal, 'Remove from site').click()
  await page.locator('#notice').getByText('Removed “El largo camino a casa” from Field Notes.').waitFor()
  assert.deepEqual((await requests(fixture.app)).map(({ request, key }) => [request, key]), [['DELETE https://one.example/tinto/posts/<post>', 'Field Notes']])

  await page.locator('#publish').click()
  await modal.getByRole('heading', { name: 'Publish' }).waitFor()
  assert.equal(await status.innerText(), 'Not published on Field Notes yet.')
  assert.deepEqual(await modal.locator('option').allInnerTexts(), ['Field Notes', 'Second Site · published'])
  await button(modal, 'Close dialog').click()

  await page.locator('#settings').click()
  await modal.getByRole('button', { name: 'Test Field Notes' }).click()
  await modal.getByText('Field Notes accepted the API key.').waitFor()
  await modal.getByRole('button', { name: 'Remove Second Site' }).click()
  await modal.getByText('Removed Second Site and its API key from Tinto. Its posts stay on the website.').waitFor()
  assert.deepEqual(await modal.locator('.site-row strong').allInnerTexts(), ['Field Notes'])
  const stored = JSON.parse((await readFile(join(fixture.profile, 'sites.enc'), 'utf8')).replace(/^sealed:/, ''))
  assert.deepEqual(stored.map(({ name, endpoint, key }) => ({ name, endpoint, key })), [{ name: 'Field Notes', endpoint: sites[0].endpoint, key: sites[0].key }])
  assert.deepEqual((await requests(fixture.app)).map(({ request, key }) => [request, key]), [['GET https://one.example/tinto', 'Field Notes']])
})
