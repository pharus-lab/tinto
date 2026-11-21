import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const site = {
  'Account ID': '0123456789abcdef0123456789abcdef',
  'D1 database ID': '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9',
  'R2 bucket': 'site-media',
  'API token': 'test-token-with-enough-characters',
  'Deploy Hook URL': 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10'
}

// The main process talks to a simulated Cloudflare API and an in-memory keychain.
async function simulateCloudflare(app, image) {
  await app.evaluate(({ safeStorage, dialog }, image) => {
    safeStorage.isAsyncEncryptionAvailable = async () => true
    safeStorage.encryptStringAsync = async text => Buffer.from('sealed:' + text)
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] })
    globalThis.cloudflareRequests = []
    globalThis.fetch = async (address, init = {}) => {
      const url = String(address)
      const headers = new Headers(init.headers)
      globalThis.cloudflareRequests.push({ url, method: init.method, auth: headers.get('Authorization'), body: typeof init.body === 'string' ? init.body : null })
      const reply = result => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/query')) return reply([{ success: true, results: [], meta: {} }])
      if (init.method === 'PUT') return reply({ key: url, size: String(init.body.byteLength) })
      if (init.method === 'DELETE') return reply({})
      return reply({ build_uuid: 'build-1', status: 'queued' })
    }
  }, image)
}
async function requests(app) {
  const list = await app.evaluate(() => globalThis.cloudflareRequests.splice(0))
  return list.map(({ url, method, auth, body }) => {
    const path = url.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/(accounts\/[0-9a-f]+\/)?/, '')
    const sql = body && JSON.parse(body).sql.trim().split(/\s+/).slice(0, 3).join(' ')
    return [method, path.replace(/\/posts\/[0-9a-f-]{36}\//, '/posts/<post>/').replace(/[0-9a-f]{32}\.png$/, '<hash>.png').replace(/check\/[0-9a-f-]+\.txt$/, 'check/<id>.txt'), auth ? 'token' : 'no token', sql].filter(Boolean)
  })
}

test('a writer connects a Cloudflare site, publishes a document with a cover, updates it and unpublishes it', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const image = join(fixture.directory, 'cover.png')
  await writeFile(image, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('kitchen window')]))
  await simulateCloudflare(fixture.app, image)
  const modal = page.getByRole('dialog')

  await page.locator('#publish').click()
  await modal.getByText('Connect your Cloudflare site in Settings').waitFor()
  await button(modal, 'Open Settings').click()
  for (const [label, value] of Object.entries(site)) await modal.getByLabel(label, { exact: true }).fill(value)
  await button(modal, 'Connect site').click()
  await modal.getByText('Connected. Tinto checked the D1 table').waitFor()
  assert.match(await modal.locator('.site-settings').innerText(), /Bucket site-media · D1 0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9/)
  assert.deepEqual(await requests(fixture.app), [
    ['POST', 'd1/database/0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9/query', 'token', 'CREATE TABLE IF'],
    ['PUT', 'r2/buckets/site-media/objects/tinto-connection-check/<id>.txt', 'token'],
    ['DELETE', 'r2/buckets/site-media/objects/tinto-connection-check/<id>.txt', 'token']
  ])
  await button(modal, 'Close dialog').click()

  await page.locator('#publish').click()
  assert.equal(await modal.getByLabel('Title', { exact: true }).inputValue(), 'The long way home')
  await modal.getByLabel('Title', { exact: true }).fill('El largo camino a casa')
  assert.equal(await modal.getByLabel('Address', { exact: true }).inputValue(), 'el-largo-camino-a-casa')
  await modal.getByLabel('Summary', { exact: true }).fill('Mara comes home in the rain.')
  await button(modal, 'Choose cover').click()
  await modal.getByLabel('Description of cover.png').fill('The kitchen window at night')
  await button(modal, 'Publish').click()
  await page.locator('#notice').getByText('Published “El largo camino a casa”. The site is rebuilding.').waitFor()
  assert.deepEqual(await requests(fixture.app), [
    ['PUT', 'r2/buckets/site-media/objects/posts/<post>/<hash>.png', 'token'],
    ['POST', 'd1/database/0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9/query', 'token', 'INSERT INTO tinto_posts'],
    ['POST', 'workers/builds/deploy_hooks/6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10', 'no token']
  ])

  await page.locator('#publish').click()
  await modal.getByRole('heading', { name: 'Update post' }).waitFor()
  assert.match(await modal.locator('.publish-status').innerText(), /^Published · .* · el-largo-camino-a-casa$/)
  assert.equal(await modal.getByLabel('Description of cover.png').inputValue(), 'The kitchen window at night')
  await button(modal, 'Update post').click()
  await page.locator('#notice').getByText('Published “El largo camino a casa”').waitFor()
  assert.deepEqual((await requests(fixture.app)).map(([method, path]) => method + ' ' + path.split('/')[0]), ['POST d1', 'POST workers'])

  await page.locator('#publish').click()
  await button(modal, 'Unpublish').click()
  await button(modal, 'Remove from site').click()
  await page.locator('#notice').getByText('Removed “El largo camino a casa” from the site.').waitFor()
  assert.deepEqual(await requests(fixture.app), [
    ['POST', 'd1/database/0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9/query', 'token', 'DELETE FROM tinto_posts'],
    ['POST', 'workers/builds/deploy_hooks/6f1c2a8e-3b9d-4e57-a0c1-9d2f7b6e4a10', 'no token'],
    ['DELETE', 'r2/buckets/site-media/objects/posts/<post>/<hash>.png', 'token']
  ])
  await page.locator('#publish').click()
  await modal.getByRole('heading', { name: 'Publish' }).waitFor()
  assert.match(await modal.locator('.publish-status').innerText(), /^Not published yet/)
})
