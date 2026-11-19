import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const html = `<!doctype html><meta charset="utf-8">
<main></main>
<nav>
  <button id="add">Add alternative</button><button id="review">Review wording</button>
  <div id="choices"></div>
  <button id="save">Save</button>
</nav>
<output></output><script type="module" src="/editor.js"></script>`

async function launchBrowser(t) {
  const executablePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
  const browser = await chromium.launch({ executablePath })
  t.after(() => browser.close())
  return browser
}

async function prepareProof(t) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('editor-fixture.js', import.meta.url))], platform: 'browser', format: 'esm', bundle: true, write: false })
  const folder = await mkdtemp(path.join(tmpdir(), 'tinto-editor-proof-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'manuscript.json')
  const browser = await launchBrowser(t)

  return async function openManuscript() {
    const context = await browser.newContext()
    await context.exposeBinding('readManuscript', async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    })
    await context.exposeBinding('writeManuscript', (_source, doc) => writeFile(file, JSON.stringify(doc)))
    await context.route('http://localhost/**', async route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html })
      if (pathname === '/editor.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (/^\/dictionaries\/en\.(dic|aff)$/.test(pathname)) {
        const extension = path.extname(pathname)
        const data = await readFile(new URL('node_modules/dictionary-en/index' + extension, root))
        return route.fulfill({ contentType: 'text/plain', body: data })
      }
      return route.abort()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    const failed = new Promise((_, reject) => page.once('pageerror', reject))
    const ready = async () => {
      await page.goto('http://localhost/')
      await page.waitForSelector('[data-ready="yes"]')
    }
    await Promise.race([ready(), failed])
    return page
  }
}

// Place a native browser selection over the visible words, including text
// split into several DOM nodes by spelling underlines or formatting.
async function selectWords(page, phrase) {
  await page.locator('.ProseMirror').evaluate((editor, words) => {
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const text = nodes.map(node => node.data).join('')
    const from = text.indexOf(words)
    if (from < 0) throw Error('Missing words: ' + words)
    const to = from + words.length
    let offset = 0
    const range = document.createRange()
    for (const node of nodes) {
      const end = offset + node.length
      if (from >= offset && from < end) range.setStart(node, from - offset)
      if (to > offset && to <= end) range.setEnd(node, to - offset)
      offset = end
    }
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, phrase)
}

const paragraph = page => page.locator('.ProseMirror p').first()
const button = (page, name) => page.getByRole('button', { name, exact: true })
const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

test('nested wording survives real typing, undo, option switching, save and reopen', async t => {
  const openManuscript = await prepareProof(t)
  let page = await openManuscript()
  await selectWords(page, 'I want to eat a cat.')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('I want to eat ice cream.')
  assert.equal(await paragraph(page).textContent(), 'I want to eat ice cream.')
  await selectWords(page, 'ice cream')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('cake')
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  await page.keyboard.press(undo)
  assert.equal(await paragraph(page).textContent(), 'I want to eat ice cream.')
  await page.keyboard.press(undo.replace('z', 'Shift+z'))
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  await button(page, 'I want to eat a cat.').click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat a cat.')
  await button(page, 'I want to eat cake.').click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  await button(page, 'Save').click()
  await page.getByText('Saved', { exact: true }).waitFor()
  await page.context().close()

  page = await openManuscript()
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  await selectWords(page, 'cake')
  await button(page, 'Review wording').click()
  assert.equal(await button(page, 'cake').getAttribute('aria-pressed'), 'true')
  await page.keyboard.type('creem')
  const misspelling = page.locator('.tinto-misspelling[data-word="creem"]')
  await misspelling.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'cream', exact: true }).click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat cream.')
  await page.keyboard.press(undo)
  assert.equal(await paragraph(page).textContent(), 'I want to eat creem.')
  assert.equal(await misspelling.count(), 1)
  await button(page, 'ice cream').click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat ice cream.')
  assert.equal(await misspelling.count(), 0)
  const cycle = button(page, 'Next passage wording')
  await cycle.focus()
  await page.keyboard.press('Space')
  assert.equal(await cycle.evaluate(element => element === document.activeElement), true)
  assert.equal(await paragraph(page).textContent(), 'I want to eat a cat.')
})

test('an outer alternative copies a complete inner group and keeps its options independent', async t => {
  const openManuscript = await prepareProof(t)
  const page = await openManuscript()
  await selectWords(page, 'a cat.')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('cake.')
  await selectWords(page, 'eat ca')
  await button(page, 'Add alternative').click()
  assert.match(await page.locator('output').innerText(), /one paragraph/)
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'eat ca')
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  await selectWords(page, 'I want to eat cake.')
  await button(page, 'Add alternative').click()
  await selectWords(page, 'cake')
  await button(page, 'Review wording').click()
  await button(page, 'a cat.').click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat a cat.')
  await button(page, 'I want to eat cake.').click()
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')

  await selectWords(page, 'cake')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('.ProseMirror p').count(), 1)
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'cake')
  assert.match(await page.locator('output').innerText(), /move outside/)
  await page.locator('.ProseMirror').evaluate(editor => {
    const data = new DataTransfer()
    data.setData('text/plain', 'First line\nSecond line')
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  assert.equal(await paragraph(page).textContent(), 'I want to eat cake.')
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'cake')
})

test('leading paragraph splits and paste preserve the ID of the existing prose', async t => {
  const openManuscript = await prepareProof(t)
  const page = await openManuscript()
  const original = paragraph(page)
  const id = await original.getAttribute('data-block-id')
  const text = await original.textContent()
  await original.evaluate(element => {
    element.closest('.ProseMirror').focus()
    getSelection().collapse(element.firstChild, 0)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press('Enter')
  const existing = page.locator('[data-block-id="' + id + '"]')
  assert.equal(await existing.textContent(), text)
  await existing.evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'A new paragraph.\nPreface. ')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  assert.equal(await existing.textContent(), 'Preface. ' + text)
  const ids = await page.locator('.ProseMirror p').evaluateAll(elements => elements.map(element => element.dataset.blockId))
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3)
})
