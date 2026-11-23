// Capture the real development app with disposable, fictional data.
// Optional UI audit: TINTO_IMPECCABLE_BIN=/path/to/impeccable npm run screenshots -- --audit
import assert from 'node:assert/strict'
import { chromium, _electron as electron } from 'playwright'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
if (process.argv.includes('--verify-readme')) {
  const { convert } = await import('pandoc-wasm')
  const rendered = await convert({ from: 'gfm', to: 'html' }, await readFile('README.md', 'utf8'), {})
  const output = join(root, 'out/qa/public-repository')
  await mkdir(output, { recursive: true })
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base href="' + pathToFileURL(root + '/').href + '"><title>Tinto README preview</title><style>body{max-width:850px;margin:32px auto;padding:24px;color:#1f2328;background:white;font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;overflow-wrap:break-word}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:8px}h2{margin-top:32px}img{max-width:100%;height:auto}code{font-size:85%;background:#f0f2f4;padding:2px 4px;border-radius:4px}a{color:#0969da}li+li{margin-top:4px}pre{overflow:auto}figure{margin:16px 0}figcaption{font-size:14px;color:#59636e}@media(max-width:600px){body{margin:0;padding:16px}}</style><main>' + rendered.stdout + '</main></html>'
  await writeFile(join(output, 'readme.html'), html)
  const browser = await chromium.launch({ args: ['--disable-gpu'], executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) })
  try {
    const page = await browser.newPage()
    await page.route(/^https?:/, route => route.abort())
    await page.goto(pathToFileURL(join(output, 'readme.html')).href)
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth))
    assert.equal(await page.locator('img[alt]').count(), 6)
    for (const [name, width, height] of [['desktop', 1280, 960], ['narrow', 390, 844]]) {
      await page.setViewportSize({ width, height })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(output, 'readme-' + name + '.png') })
      if (name === 'desktop') {
        await page.locator('img[src$="publishing.png"]').scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(output, 'readme-publishing.png') })
        await page.evaluate(() => scrollTo(0, 0))
      }
    }
    console.log('README preview: six images loaded, with no page overflow at 1280px or 390px.')
  } finally { await browser.close() }
  process.exit(0)
}
const executablePath = process.env.TINTO_PACKAGED_EXECUTABLE
if (!executablePath) await import('./build.mjs')
const audit = process.argv.includes('--audit')
const impeccable = process.env.TINTO_IMPECCABLE_BIN ?? join(homedir(), '.agents/skills/impeccable/scripts/impeccable')
const qa = process.env.TINTO_CAPTURE_DIR ? resolve(process.env.TINTO_CAPTURE_DIR) : join(root, 'out/qa/public-repository')
const output = process.env.TINTO_CAPTURE_DIR ? qa : join(root, 'docs/screenshots')
const temporary = await mkdtemp(join(tmpdir(), 'tinto-readme-'))
const folder = join(temporary, 'Manuscripts'), site = join(temporary, 'website')
await Promise.all([mkdir(output, { recursive: true }), mkdir(qa, { recursive: true }), mkdir(folder), mkdir(site)])
await writeFile(join(site, 'wrangler.jsonc'), '{ "name": "field-notes" }\n')
const listener = createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const results = [], errors = []
const run = promisify(execFile)
let app

try {
  app = await electron.launch({ executablePath, chromiumSandbox: process.platform === 'linux' && !!executablePath,
    args: [...(executablePath ? [] : [root]), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], cwd: root,
    env: { ...process.env, TZ: 'UTC', TINTO_USER_DATA: join(temporary, 'profile'), TINTO_RELEASES_URL: 'http://127.0.0.1:9/releases/latest', TINTO_EXPERIMENTAL: '0' } })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForURL('tinto://app/index.html')
  await page.clock.setFixedTime(new Date('2026-11-23T12:00:00Z'))
  await page.route(/^https?:/, route => route.abort())
  const window = await app.browserWindow(page)
  await window.evaluate(win => { win.setContentSize(1280, 860); win.show(); win.focus() })
  const inspector = await app.context().newCDPSession(page)
  const button = (name, scope = page) => scope.getByRole('button', { name, exact: true })
  const modal = page.locator('#modal')

  // Only this temporary profile sees the fake keychain and website. No live requests.
  await app.evaluate(({ dialog, safeStorage, shell }, { folder, site }) => {
    Date.now = () => Date.UTC(2026, 10, 23, 12)
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.title?.includes('website') ? site : folder] })
    dialog.showMessageBox = async () => ({ response: 0 })
    safeStorage.isAsyncEncryptionAvailable = async () => true
    if (process.platform === 'linux') safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret'
    safeStorage.encryptStringAsync = async text => Buffer.from('demo:' + text)
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).toString().slice(5), shouldReEncrypt: false })
    shell.openExternal = async () => { throw Error('External navigation is disabled during capture.') }
    globalThis.fetch = async (address, init = {}) => {
      if (String(address) === 'https://blog.example/api/tinto' && init.method === 'GET') {
        return Response.json({ tinto: 2, name: 'Field Notes', categories: [{ id: 'essays', label: 'Essays' }, { id: 'notes', label: 'Notes' }] })
      }
      throw Error('Network requests are disabled during capture.')
    }
  }, { folder, site })

  async function capture(name, { publicImage = true, inspect = false } = {}) {
    await window.evaluate(win => { win.show(); win.focus() })
    await page.mouse.move(0, 0)
    await page.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready })
    await page.waitForTimeout(200)
    const privacy = await page.evaluate(() => {
      const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      return document.body.innerText + '\n' + [...document.querySelectorAll('input,textarea')].filter(visible).map(el => el.value).join('\n')
    })
    if (publicImage) {
      assert.doesNotMatch(privacy, /\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\//)
      assert.ok(!privacy.includes('demo-website-key'), 'fixture keys must stay outside captures')
      assert.equal(await page.locator('dialog.guide input[type=password]').count(), 0)
    }
    const screenshot = await inspector.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(publicImage ? output : qa, name + '.png'), Buffer.from(screenshot.data, 'base64'))
    if (inspect && audit) {
      const layout = await page.evaluate(() => {
        const root = [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body
        const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0
        const controls = [...root.querySelectorAll('button,input,select,textarea,[role=tab]')].filter(visible)
        const small = controls.filter(el => !el.disabled).flatMap(el => {
          const target = el.labels?.length ? el.labels[0] : el, rect = target.getBoundingClientRect()
          return rect.width < 24 || rect.height < 24 ? [{ label: el.getAttribute('aria-label') || el.textContent?.trim(), width: rect.width, height: rect.height }] : []
        })
        return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1, small, controls: controls.length }
      })
      let response
      try { response = await run(impeccable, ['detect', '--cdp', String(port), '--target', 'tinto://app/index.html', '--json'], { cwd: root, timeout: 60_000, maxBuffer: 8_000_000 }) }
      catch (error) { if (error.code === 2) response = error; else throw error }
      const findings = JSON.parse(response.stdout)
      results.push({ name, layout, findings })
      await writeFile(join(qa, name + '-detect.json'), response.stdout)
      console.log(JSON.stringify({ name, layout, findings: findings.length }))
    } else console.log('Captured ' + name)
  }

  async function reload(appearance = 'light') {
    await page.evaluate(appearance => {
      const prefs = JSON.parse(localStorage.getItem('reading') ?? '{}')
      localStorage.setItem('reading', JSON.stringify({ ...prefs, appearance, checkUpdates: false }))
    }, appearance)
    await page.reload()
    await page.locator('.ProseMirror:visible').waitFor()
  }

  await button('Choose folder').click()
  await button('Open sample project').click()
  await page.locator('.ProseMirror:visible').waitFor()
  const clean = await page.evaluate(async () => {
    const { path, project } = await window.tinto.workspace(), doc = project.documents[0]
    const text = text => ({ type: 'text', text })
    const passage = doc.manuscript.content[2]
    const sentence = passage.content.find(node => node.type === 'choice')
    const nested = sentence.content.find(node => node.type === 'choice')
    nested.content = [text('a light left on')]
    nested.attrs.options[0].content = [text('someone waiting')]
    sentence.content = [text('Home was '), nested, text('.')]
    sentence.attrs.options[0].content = [text('The house had been waiting for her.')]
    passage.content = [text('For a moment, she understood. '), sentence]
    doc.manuscript.content[3].content = [text('Her brother set a cup on the table. Neither of them spoke. After so many miles, the small silence felt like a welcome.')]
    window.tinto.save(path, project.id, doc)
    await window.tinto.createAuthor('Mara Ruiz')
    await window.tinto.addSite('https://blog.example/api/tinto', 'demo-website-key-no-live-access')
    return structuredClone(doc.manuscript)
  })
  await reload()
  await capture('writing-alternatives')

  await button('Create draft').click()
  const create = page.getByRole('dialog', { name: 'Create independent draft' })
  await create.getByLabel('Draft name').fill('A quieter beginning')
  await button('Create draft', create).click()
  await button('Review draft').waitFor()
  await page.evaluate(async () => {
    const { path, project } = await window.tinto.workspace()
    const draft = project.documents.find(doc => doc.source), original = project.documents.find(doc => doc.id === draft.source.documentId)
    original.manuscript.content[1].content = [{ type: 'text', text: 'The house was quiet when Mara arrived. The kitchen window stood open, and rain touched the sill.' }]
    draft.manuscript.content[1].content = [{ type: 'text', text: 'Mara arrived to find the kitchen light still on. Rain whispered through the open window.' }]
    window.tinto.save(path, project.id, original)
    window.tinto.save(path, project.id, draft)
  })
  await reload()
  await button('Review draft').click()
  const review = page.getByRole('dialog', { name: 'Review draft' })
  await review.getByLabel('Result', { exact: true }).selectOption('draft')
  await capture('draft-review')
  await button('Close review draft', review).click()
  await button('The long way home', page.locator('#tabs')).click()

  await page.evaluate(async () => {
    const { path, project } = await window.tinto.workspace(), doc = project.documents.find(doc => !doc.source)
    await window.tinto.nameVersion(doc.id, 'Before the final pass')
    doc.manuscript.content[1].content = [{ type: 'text', text: 'The house was quiet when Mara arrived. Someone had left the kitchen light on, and the window above the sink stood open to the rain.' }]
    doc.manuscript.content[4].content = [{ type: 'text', text: 'There were two cups on the table. She drew the warm one towards her and held it in both hands.' }]
    window.tinto.save(path, project.id, doc)
  })
  await reload()
  await button('History').click()
  await modal.getByRole('table', { name: 'Changed passages' }).waitFor()
  await capture('history-comparison')
  await button('Close history', modal).click()

  await page.evaluate(async clean => {
    const { path, project } = await window.tinto.workspace(), doc = project.documents.find(doc => !doc.source)
    doc.manuscript = clean
    doc.manuscript.content[1].content = [{ type: 'text', text: 'The house was quiet when Mara arrived. Someone had left the kitchen light on, and a cup of cofffee waited on the table.' }]
    doc.manuscript.content[3].content = [{ type: 'text', text: 'This was a invitation to stay. She go to the window and listened to the rain.' }]
    window.tinto.save(path, project.id, doc)
  }, clean)
  await reload('dark')
  await page.locator('#check-writing').click()
  await page.locator('#writing-checks [role=status]').filter({ hasText: /possible issues/ }).waitFor()
  await capture('writing-checks', { inspect: true })

  await page.evaluate(async clean => {
    const { path, project } = await window.tinto.workspace(), doc = project.documents.find(doc => !doc.source)
    doc.manuscript = clean
    window.tinto.save(path, project.id, doc)
  }, clean)
  await reload()
  await page.locator('#publish').click()
  await modal.getByLabel('Summary', { exact: true }).fill('A quiet homecoming, a light left on, and the small things that make a place our own.')
  await modal.getByLabel('Tags', { exact: true }).fill('fiction, homecoming')
  await capture('publishing')
  await button('Close dialog', modal).click()

  await page.locator('#settings').click()
  await modal.getByRole('tab', { name: 'Websites', exact: true }).click()
  await button('How to connect a website').click()
  const guide = page.locator('dialog.guide')
  if (audit) await capture('guide-intro-light', { publicImage: false, inspect: true })
  await guide.getByLabel('Site name', { exact: true }).fill('Field Notes')
  await guide.getByLabel('Site address', { exact: true }).fill('https://blog.example')
  await button('Next', guide).click()
  await app.evaluate(({ dialog }, site) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [site] }) }, site)
  await button('Save module to your site…', guide).click()
  await guide.getByText('Saved in ' + join(site, 'tinto') + '.').waitFor()
  await button('Next', guide).click()
  await guide.getByRole('heading', { name: '3. Connect it with your agent' }).waitFor()
  await capture('website-setup', { inspect: true })

  if (audit) {
    await window.evaluate(win => win.setContentSize(740, 800))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'tinto'; document.documentElement.style.colorScheme = 'dark' })
    await capture('guide-narrow-dark', { publicImage: false, inspect: true })
    await window.evaluate(win => win.webContents.setZoomFactor(2))
    await capture('guide-zoom', { publicImage: false, inspect: true })
    await window.evaluate(win => win.webContents.setZoomFactor(1))
    await button('Close dialog', guide).click()
    await modal.getByRole('tab', { name: 'Writing', exact: true }).click()
    await capture('settings-narrow-dark', { publicImage: false, inspect: true })
    await modal.getByLabel('Default spelling language').scrollIntoViewIfNeeded()
    await capture('settings-languages-dark', { publicImage: false, inspect: true })
    await window.evaluate(win => win.setContentSize(1280, 860))
    await page.evaluate(() => { document.documentElement.style.colorScheme = 'light' })
    await modal.getByLabel('Check spelling while typing', { exact: true }).scrollIntoViewIfNeeded()
    await capture('settings-light', { publicImage: false, inspect: true })
  }
  assert.deepEqual(errors, [])
  await writeFile(join(qa, 'results.json'), JSON.stringify({ results, errors }, null, 2) + '\n')
  console.log('Six screenshots saved to ' + output + '. All content is fictional.')
} finally {
  if (app) await app.close()
  await rm(temporary, { recursive: true, force: true })
}
