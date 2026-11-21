import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
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
      if (pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('src/styles.css', root)) })
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
async function selectWords(page, phrase, editor = page.locator('main .ProseMirror')) {
  await editor.evaluate((editor, words) => {
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

test('backspacing the last letter leaves an editable empty alternative until the next deletion', async t => {
  const openManuscript = await prepareProof(t)
  let page = await openManuscript()
  await selectWords(page, 'cat')
  await button(page, 'Add alternative').click()
  let choice = paragraph(page).locator('[data-choice-id]')
  const end = await choice.evaluate(el => {
    const box = el.getBoundingClientRect()
    return { x: box.right - 1, y: box.top + box.height / 2 }
  })
  await page.mouse.click(end.x, end.y)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
  assert.equal(await paragraph(page).textContent(), 'I want to eat a .')
  assert.equal(await choice.count(), 1, 'the empty alternative stays in the manuscript')
  assert.equal(await choice.evaluate(el => el.contains(getSelection().anchorNode)), true)
  assert.ok((await choice.boundingBox()).width > 4)
  await button(page, 'cat').click()
  assert.equal(await choice.textContent(), 'cat')
  await button(page, '(Empty wording)').click()
  await button(page, 'Save').click()
  await page.getByText('Saved', { exact: true }).waitFor()
  await page.context().close()
  page = await openManuscript()
  choice = paragraph(page).locator('[data-choice-id]')
  await choice.click()
  assert.equal(await choice.evaluate(el => el.contains(getSelection().anchorNode)), true)
  await page.keyboard.type('dog')
  assert.equal(await choice.textContent(), 'dog')
  await selectWords(page, 'dog')
  await page.keyboard.press('Backspace')
  assert.equal(await choice.count(), 1)
  await page.keyboard.press('Backspace')
  assert.equal(await choice.count(), 0)
  assert.equal(await paragraph(page).textContent(), 'I want to eat a .')
  await page.keyboard.press(undo)
  assert.equal(await choice.count(), 1)
  assert.equal(await choice.textContent(), '')
})

test('forward deletion from inside a wording preserves its empty box and adjacent prose', async t => {
  const page = await (await prepareProof(t))()
  await selectWords(page, 'cat')
  await button(page, 'Add alternative').click()
  const choice = paragraph(page).locator('[data-choice-id]')
  await choice.click()
  const offset = await choice.evaluate(() => getSelection().anchorOffset)
  assert.ok(offset > 0 && offset < 3)
  for (let i = 0; i < offset; i++) await page.keyboard.press('Backspace')
  for (let i = offset; i <= 3; i++) await page.keyboard.down('Delete')
  await page.keyboard.up('Delete')
  assert.equal(await choice.count(), 1)
  assert.equal(await choice.textContent(), '')
  await page.keyboard.press('Delete')
  assert.equal(await choice.count(), 0)
  assert.equal(await paragraph(page).textContent(), 'I want to eat a .')
})

test('sidebar editing and deletion work on inactive and active options and can be undone', async t => {
  const page = await (await prepareProof(t))()
  await selectWords(page, 'cat')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('dog')
  await button(page, 'Add option').click()
  await page.keyboard.type('fox')

  await button(page, 'Edit dog in sidebar').click()
  const draft = page.getByRole('textbox', { name: 'Option wording' })
  await page.keyboard.type('hound')
  await button(page, 'Save wording').click()
  assert.equal(await button(page, 'hound').getAttribute('aria-pressed'), 'false')
  assert.equal(await paragraph(page).textContent(), 'I want to eat a fox.')

  async function menuAction(wording, command) {
    await button(page, wording).click({ button: 'right' })
    await page.getByRole('menuitem', { name: command }).click()
  }
  await menuAction('fox', 'Edit wording')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  assert.equal(await paragraph(page).textContent(), 'I want to eat a fox.')
  await menuAction('fox', 'Edit wording')
  await page.keyboard.press('Backspace')
  await draft.press('Enter')
  assert.equal(await button(page, '(Empty wording)').getAttribute('aria-pressed'), 'true')
  await menuAction('cat', 'Delete wording')
  assert.equal(await button(page, 'cat').count(), 0)
  await menuAction('(Empty wording)', 'Delete wording')
  assert.equal(await paragraph(page).textContent(), 'I want to eat a hound.')
  assert.equal(await paragraph(page).locator('[data-choice-id]').count(), 0)
  await page.locator('main .ProseMirror').focus()
  await page.keyboard.press(undo)
  assert.equal(await paragraph(page).locator('[data-choice-id]').count(), 1)
  assert.equal(await button(page, 'hound').count(), 1)
  assert.equal(await button(page, '(Empty wording)').getAttribute('aria-pressed'), 'true')
})

test('editing a hidden passage in the sidebar preserves its nested alternatives and marks', async t => {
  const page = await (await prepareProof(t))()
  await selectWords(page, 'cat')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('dog')
  await selectWords(page, 'eat a dog.')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('sleep.')
  await button(page, 'Edit eat a dog. in sidebar').click()
  await selectWords(page, 'eat', page.getByRole('textbox', { name: 'Option wording' }))
  await page.keyboard.type('feed')
  await button(page, 'Save wording').click()
  assert.equal(await paragraph(page).textContent(), 'I want to sleep.')
  await button(page, 'feed a dog.').click()
  assert.equal(await paragraph(page).locator('strong').textContent(), 'dog')
  await button(page, 'cat').click()
  assert.equal(await paragraph(page).textContent(), 'I want to feed a cat.')
  assert.equal(await paragraph(page).locator('strong').textContent(), 'cat')
})

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

test('native copy, cut and paste preserve independent nested choices and their hidden marked wording', async t => {
  const openManuscript = await prepareProof(t)
  const page = await openManuscript()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await selectWords(page, 'I want to eat a cat.')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('I want to eat ice cream.')
  await selectWords(page, 'ice cream')
  await page.keyboard.press(mod + '+b')
  await button(page, 'Add alternative').click()
  await page.keyboard.type('cake')
  const paragraphs = page.locator('.ProseMirror p')
  const ids = el => el.locator('[data-choice-id]').evaluateAll(nodes => nodes.map(node => node.dataset.choiceId))
  const originalIds = await ids(paragraphs.first())

  await page.keyboard.press(mod + '+a')
  await page.keyboard.press(mod + '+c')
  await paragraphs.first().evaluate(el => {
    getSelection().collapse(el, el.childNodes.length)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press('Enter')
  await page.evaluate(() => document.addEventListener('paste', event => {
    window.clipboardText = event.clipboardData.getData('text/plain')
    window.clipboardHTML = event.clipboardData.getData('text/html')
  }, { capture: true, once: true }))
  await page.keyboard.press(mod + '+v')
  assert.deepEqual(await paragraphs.allTextContents(), ['I want to eat cake.', 'I want to eat cake.'])
  assert.equal(await page.evaluate(() => window.clipboardText), 'I want to eat cake.')
  assert.doesNotMatch(await page.evaluate(() => window.clipboardHTML), /a cat|ice cream|data-choice|data-pm-slice|reviewed-wording/)
  const copiedIds = await ids(paragraphs.last())
  assert.equal(copiedIds.length, 2)
  assert.equal(new Set([...originalIds, ...copiedIds]).size, 4)
  async function inspectCopy() {
    await paragraphs.last().locator('[data-choice-id]').last().click()
    await button(page, 'Review wording').click()
  }
  await inspectCopy()
  await button(page, 'ice cream').click()
  assert.equal(await paragraphs.last().locator('strong').textContent(), 'ice cream')
  assert.equal(await paragraphs.first().locator('strong').textContent(), 'cake')
  await button(page, 'I want to eat a cat.').click()
  assert.equal(await paragraphs.last().textContent(), 'I want to eat a cat.')
  await button(page, 'I want to eat ice cream.').click()
  await paragraphs.last().evaluate(el => {
    el.closest('.ProseMirror').focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press(mod + '+x')
  assert.deepEqual(await paragraphs.allTextContents(), ['I want to eat cake.', ''])
  await page.keyboard.press(mod + '+v')
  assert.deepEqual(await paragraphs.allTextContents(), ['I want to eat cake.', 'I want to eat ice cream.'])
  assert.equal(new Set([...originalIds, ...copiedIds, ...await ids(paragraphs.last())]).size, 6)
  await inspectCopy()
  await button(page, 'cake').click()
  assert.equal(await paragraphs.last().locator('strong').textContent(), 'cake')

  await selectWords(page, 'ak')
  await page.keyboard.press(mod + '+c')
  await paragraphs.last().evaluate(el => {
    getSelection().collapse(el, el.childNodes.length)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press(mod + '+v')
  assert.equal(await paragraphs.last().textContent(), 'I want to eat cake.ak')
  assert.equal(await paragraphs.last().locator(':scope > strong').textContent(), 'ak')
  assert.equal((await ids(paragraphs.last())).length, 2)

  await page.keyboard.press(mod + '+a')
  await page.keyboard.press(mod + '+c')
  await selectWords(page, 'cake')
  await page.keyboard.press(mod + '+v')
  assert.match(await page.locator('output').innerText(), /move outside/)
  assert.equal(await page.evaluate(() => getSelection().toString()), 'cake')
  await selectWords(page, 'eat ca')
  await page.keyboard.press(mod + '+x')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'eat ca')
  assert.equal(await paragraphs.first().textContent(), 'I want to eat cake.')
})
