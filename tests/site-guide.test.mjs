import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createTintoBlog } from '../modules/cloudflare/worker.mjs'
import { desktopFixture } from './desktop-fixture.mjs'

const bundle = await build({ entryPoints: ['src/module-export.ts'], platform: 'node', format: 'esm', bundle: true, write: false })
const { moduleConfig, writeModule, checkModuleSite } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const source = 'modules/cloudflare'
const template = await readFile(join(source, 'tinto.config.mjs'), 'utf8')
const importConfig = async text => (await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))).default

test('the module configuration gets the site name and address, safely quoted', async () => {
  const text = moduleConfig(template, { name: ' It\'s "my" blog ', site: 'https://Blog.example/some/page?x=1' })
  const config = await importConfig(text)
  assert.equal(config.name, 'It\'s "my" blog')
  assert.equal(config.site, 'https://blog.example')
  assert.equal(config.languages, null)
  assert.equal(config.postPath, null)
  assert.equal(config.author, null)
  assert.doesNotThrow(() => createTintoBlog(config))
  // The writer's own author key locks a new site to them; anything else is left null.
  const did = 'did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp'
  const locked = await importConfig(moduleConfig(template, { name: 'a', site: 'https://a.example', author: did }))
  assert.equal(locked.author, did)
  assert.doesNotThrow(() => createTintoBlog(locked))
  assert.equal((await importConfig(moduleConfig(template, { name: 'a', site: 'https://a.example', author: "x' + alert(1) + '" }))).author, null)
  assert.throws(() => moduleConfig(template.replace("name: 'Example'", "name: 'Changed'"), { name: 'a', site: 'https://a.example' }), /unexpected configuration file/)
  for (const values of [{ name: '', site: 'https://a.example' }, { name: 'a', site: 'a.example' }, { name: 'a', site: 'ftp://a.example' }]) {
    assert.throws(() => checkModuleSite(values))
  }
})

test('writing the module twice updates the code and keeps the site configuration', async t => {
  const fixture = await desktopFixture(t)
  const folder = join(fixture.directory, 'site')
  await mkdir(folder)
  assert.deepEqual(await writeModule(folder, source, { name: 'Field Notes', site: 'https://blog.example' }), { path: join(folder, 'tinto'), updated: false })
  await writeFile(join(folder, 'tinto', 'tinto.config.mjs'), (await readFile(join(folder, 'tinto', 'tinto.config.mjs'), 'utf8')) + '// edited by the site\n')
  await writeFile(join(folder, 'tinto', 'worker.mjs'), '// stale copy\n')
  assert.equal((await writeModule(folder, source, { name: 'Other', site: 'https://other.example' })).updated, true)
  assert.match(await readFile(join(folder, 'tinto', 'tinto.config.mjs'), 'utf8'), /name: "Field Notes"[\s\S]*edited by the site/)
  assert.equal(await readFile(join(folder, 'tinto', 'worker.mjs'), 'utf8'), await readFile(join(source, 'worker.mjs'), 'utf8'))
})

// The main process sees simulated pickers, message boxes, clipboard, browser and website.
async function simulate(app) {
  await app.evaluate(({ safeStorage, dialog, clipboard, shell }) => {
    safeStorage.isAsyncEncryptionAvailable = async () => true
    safeStorage.encryptStringAsync = async text => Buffer.from('sealed:' + text)
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false })
    const state = globalThis.guide = { folders: [], answers: [], questions: [], copied: [], opened: [], requests: [], live: false }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [state.folders.shift()] })
    dialog.showMessageBox = async (window, options) => { state.questions.push(options.message); return { response: state.answers.shift() ?? 0 } }
    clipboard.writeText = text => { state.copied.push(text) }
    shell.openExternal = async url => { state.opened.push(url) }
    globalThis.fetch = async (address, init = {}) => {
      state.requests.push([String(address), new Headers(init.headers).get('Authorization')])
      return state.live ? Response.json({ tinto: 2, name: 'Field Notes', categories: [] }) : new Response('Not found', { status: 404 })
    }
  })
}
const guideState = app => app.evaluate(() => globalThis.guide)
async function until(check) {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
}

test('the guide adds the module to a site, hands the agent its prompts, creates the key and connects', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  await simulate(fixture.app)
  const site = join(fixture.directory, 'my-site')
  const bare = join(fixture.directory, 'not-a-worker')
  await mkdir(site)
  await mkdir(bare)
  await writeFile(join(site, 'wrangler.jsonc'), '{ "name": "my-site" }')

  await page.locator('#settings').click()
  await page.getByRole('tab', { name: 'Websites' }).click()
  await page.getByRole('button', { name: 'How to connect a website', exact: true }).click()
  const guide = page.locator('dialog.guide')
  const button = name => guide.getByRole('button', { name, exact: true })
  const status = guide.locator('.guide-status')
  await guide.getByRole('heading', { name: '1. Your site' }).waitFor()
  await button('Next').click()
  assert.equal(await status.innerText(), 'Give the website a name of up to 80 characters.')
  await guide.getByLabel('Site name', { exact: true }).fill('Field Notes')
  await guide.getByLabel('Site address', { exact: true }).fill('https://blog.example/about')
  await button('Next').click()

  await guide.getByRole('heading', { name: '2. Add the module' }).waitFor()
  await fixture.app.evaluate((_, folder) => { globalThis.guide.folders.push(folder); globalThis.guide.answers.push(0) }, bare)
  await button('Save module to your site…').click()
  await until(async () => (await guideState(fixture.app)).questions.length === 1)
  assert.deepEqual((await guideState(fixture.app)).questions, ['This folder has no Wrangler configuration.'])
  assert.equal(existsSync(join(bare, 'tinto')), false)

  await fixture.app.evaluate((_, folder) => globalThis.guide.folders.push(folder), site)
  await button('Save module to your site…').click()
  await guide.getByText('Saved in ' + join(site, 'tinto') + '.').waitFor()
  const files = (await readdir(join(site, 'tinto'))).sort()
  assert.deepEqual(files, ['README.md', 'astro.mjs', 'credential.mjs', 'files.mjs', 'shared.mjs', 'tinto.config.mjs', 'worker.mjs'])
  for (const file of files.filter(file => file !== 'tinto.config.mjs')) {
    assert.equal(await readFile(join(site, 'tinto', file), 'utf8'), await readFile(join(source, file), 'utf8'), file)
  }
  const config = (await import(pathToFileURL(join(site, 'tinto', 'tinto.config.mjs')).href)).default
  assert.deepEqual([config.name, config.site], ['Field Notes', 'https://blog.example'])
  const { createTintoBlog: written } = await import(pathToFileURL(join(site, 'tinto', 'worker.mjs')).href)
  assert.doesNotThrow(() => written(config))

  await writeFile(join(site, 'tinto', 'tinto.config.mjs'), (await readFile(join(site, 'tinto', 'tinto.config.mjs'), 'utf8')) + '// site settings\n')
  await fixture.app.evaluate((_, folder) => { globalThis.guide.folders.push(folder); globalThis.guide.answers.push(1) }, site)
  await button('Save module to your site…').click()
  await guide.getByText('Updated the module in ' + join(site, 'tinto') + '. Your tinto.config.mjs was kept.').waitFor()
  assert.match(await readFile(join(site, 'tinto', 'tinto.config.mjs'), 'utf8'), /\/\/ site settings\n$/)
  assert.equal((await guideState(fixture.app)).questions.at(-1), 'This website already has a tinto folder.')
  await button('Next').click()

  await guide.getByRole('heading', { name: '3. Connect it with your agent' }).waitFor()
  await guide.getByRole('button', { name: 'Copy Connect prompt' }).click()
  await status.getByText('Connect prompt copied.').waitFor()
  await guide.getByRole('button', { name: 'Copy Design prompt' }).click()
  await status.getByText('Design prompt copied.').waitFor()
  const [connect, design] = (await guideState(fixture.app)).copied
  for (const part of ['Tinto saved the module in ' + site + '/tinto.', 'name is "Field Notes" and site is "https://blog.example"', '"d1_databases": [{ "binding": "TINTO_DB" }]', '"r2_buckets": [{ "binding": "TINTO_MEDIA" }]',
    'after any redirect to the canonical host and before static assets', 'Do not create secrets, deploy, commit or push.', 'The publishing URL will be https://blog.example/api/tinto.']) {
    assert.ok(connect.includes(part), part)
  }
  assert.match(design, /reuse the site's existing layout, components, typography and styles\. Do not add a new visual style\./)
  await button('Next').click()

  await guide.getByRole('heading', { name: '4. Key and deploy' }).waitFor()
  const key = await guide.getByLabel('API key', { exact: true }).inputValue()
  assert.match(key, /^[A-Za-z0-9_-]{43}$/)
  await guide.getByRole('button', { name: 'Copy API key' }).click()
  await guide.getByRole('button', { name: 'Copy Key command' }).click()
  await guide.getByRole('button', { name: 'Copy Hook command' }).click()
  await button('Open Cloudflare dashboard').click()
  await status.getByText('Hook command copied.').waitFor()
  let state = await guideState(fixture.app)
  assert.deepEqual(state.copied.slice(2), [key, 'npx wrangler secret put TINTO_API_KEY', 'npx wrangler secret put TINTO_DEPLOY_HOOK'])
  assert.deepEqual(state.opened, ['https://dash.cloudflare.com/?to=/:account/workers-and-pages'])
  assert.ok(await guide.getByText('https://blog.example/api/tinto/feed').isVisible())
  await button('Next').click()

  await guide.getByRole('heading', { name: '5. Connect Tinto' }).waitFor()
  assert.equal(await guide.getByLabel('Publishing URL', { exact: true }).inputValue(), 'https://blog.example/api/tinto')
  assert.equal(await guide.getByLabel('API key', { exact: true }).inputValue(), key)
  await button('Connect website').click()
  await status.getByText('There is no Tinto blog module at this publishing URL. Copy the URL from the website again.').waitFor()
  assert.ok(await guide.isVisible())
  await fixture.app.evaluate(() => { globalThis.guide.live = true })
  await button('Connect website').click()
  await guide.getByText('Connected Field Notes. Use Publish to send a document or section to it.').waitFor()
  state = await guideState(fixture.app)
  assert.deepEqual(state.requests.at(-1), ['https://blog.example/api/tinto', 'Bearer ' + key])
  await button('Done').click()
  await guide.waitFor({ state: 'detached' })
  const settings = page.getByRole('dialog')
  await settings.getByText('Connected Field Notes. The website accepted the API key.').waitFor()
  assert.deepEqual(await settings.locator('.site-row strong').allInnerTexts(), ['Field Notes'])
})
