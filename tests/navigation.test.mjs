import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

test('text width modes retain their dimensions as the writing area resizes', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const settings = page.getByRole('button', { name: 'Reading and project settings' })
  const mode = page.getByLabel('Text width')
  const margin = page.getByLabel('Margin on each side (px)')
  const column = page.getByLabel('Column width (px)')
  async function resize(width) {
    await fixture.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width)
    await page.waitForFunction(width => window.innerWidth === width, width)
  }
  function geometry() {
    return page.locator('.ProseMirror:visible').evaluate(editor => {
      const pane = document.getElementById('scroll')
      const left = editor.getBoundingClientRect().left - pane.getBoundingClientRect().left
      const width = editor.getBoundingClientRect().width
      return { left, width, right: pane.clientWidth - width - left }
    })
  }
  await resize(1100)
  await settings.click()
  assert.deepEqual(await mode.locator('option').allTextContents(), ['Fixed Width', 'Fixed Margin'])
  assert.equal(await mode.inputValue(), 'fixed-margin')
  assert.equal(await margin.inputValue(), '48')
  await margin.fill('62')
  const wide = await geometry()
  assert.deepEqual([wide.left, wide.right], [62, 62])
  await resize(800)
  const narrow = await geometry()
  assert.deepEqual([narrow.left, narrow.right], [62, 62])
  assert.ok(narrow.width < wide.width)

  await mode.selectOption({ label: 'Fixed Width' })
  assert.equal(await column.inputValue(), '680')
  await column.fill('640')
  assert.equal((await geometry()).width, 640)
  assert.ok(await page.locator('#scroll').evaluate(pane => pane.scrollWidth > pane.clientWidth))
  await resize(1100)
  const fixed = await geometry()
  assert.equal(fixed.width, 640)
  assert.ok(Math.abs(fixed.left - fixed.right) <= 1)

  await page.reload()
  await settings.click()
  assert.equal(await mode.inputValue(), 'fixed-width')
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('reading'))
    saved.textWidth = 'free'
    localStorage.setItem('reading', JSON.stringify(saved))
  })
  await page.reload()
  await settings.click()
  assert.equal(await mode.inputValue(), 'fixed-margin')
  assert.equal(await margin.inputValue(), '62')
  await mode.selectOption({ label: 'Fixed Width' })
  assert.equal(await column.inputValue(), '640')
})

test('linked sections share edits, the trail follows scrolling, and keyboard review works in both appearances', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const button = name => page.getByRole('button', { name, exact: true })
  await button('I want to eat cake.').waitFor()
  for (const scheme of ['light','dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    const next = button('Next nested wording')
    await next.focus()
    await page.keyboard.press('Space')
    assert.equal(await next.evaluate(element => element === document.activeElement), true)
    const outline = await next.evaluate(element => getComputedStyle(element).outlineStyle)
    assert.equal(outline, 'solid')
    assert.equal(await page.locator('.alt-nested .alt-option[aria-pressed=true] .alt-check').innerText(), '✓')
    assert.match(await page.locator('.tab.current').evaluate(element => getComputedStyle(element).boxShadow), /inset/)
    if (scheme === 'dark' && process.env.TINTO_DARK_SCREENSHOT) await page.screenshot({ path: process.env.TINTO_DARK_SCREENSHOT, scale: 'css' })
  }
  await button('Reading and project settings').click()
  await page.getByLabel('Manuscript font size').selectOption('25')
  await page.getByLabel('Line spacing').selectOption('1.95')
  await page.keyboard.press('Escape')
  const size = () => page.locator('.ProseMirror:visible').evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])
  assert.deepEqual(await size(), ['25px', '48.75px'])
  await page.reload()
  await page.locator('.ProseMirror:visible').waitFor()
  assert.deepEqual(await size(), ['25px', '48.75px'])
  await button('Home').click()
  await button('The garden').click()
  const heading = page.locator('.ProseMirror h1:visible')
  assert.equal(await heading.count(), 1)
  await heading.click()
  await heading.evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.type('The orchard')
  assert.equal(await heading.textContent(), 'The orchard')
  await button('The orchard').waitFor()
  const source = button('The long way home')
  await source.click()
  assert.equal(await page.locator('.ProseMirror h1:visible').allTextContents().then(all => all.join('/')), 'The kitchen/The orchard')
  await page.locator('#scroll').evaluate(scroller => { scroller.scrollTop = scroller.scrollHeight })
  await page.waitForFunction(() => document.getElementById('trail').textContent.includes('The orchard'))
  await button('The orchard').click()
  assert.equal(await heading.count(), 1)
  await source.click()
  await page.waitForFunction(() => document.getElementById('trail').textContent.includes('The orchard'))
  await page.locator('#scroll').evaluate(scroller => { scroller.scrollTop = 0 })
  await page.waitForFunction(() => document.getElementById('trail').innerText.trim() === 'The long way home')
})

test('a delayed save after opening a restored copy stays in its originating project file', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const { app, directory } = fixture
  await page.locator('.ProseMirror:visible').waitFor()
  const original = await page.evaluate(() => window.tinto.workspace())
  const restoredPath = join(directory, 'Restored.tinto')
  await copyFile(original.path, restoredPath)
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, restoredPath)
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.waitForFunction(async path => (await window.tinto.workspace()).path === path, restoredPath)
  const originalDoc = original.project.documents[0]
  const pending = { ...originalDoc, title: 'Last edit in the original' }
  const after = await page.evaluate(async ({ original, pending }) => {
    const error = window.tinto.save(original.path, original.project.id, pending)
    if (error) throw Error(error)
    return window.tinto.workspace()
  }, { original, pending })
  assert.equal(after.project.documents[0].title, originalDoc.title)
  const reopened = await page.evaluate(index => window.tinto.open(index), after.recent.findIndex(item => item.path === original.path))
  assert.equal(reopened.project.documents[0].title, pending.title)
})

test('first launch lets the writer choose, create and revisit local project folders', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.launch()
  const { folder, profile, directory } = fixture
  const button = name => page.getByRole('button', { name, exact: true })
  const welcome = () => page.getByRole('heading', { name: 'Choose your Tinto folder' })
  const library = () => page.evaluate(() => window.tinto.library())
  const editor = () => page.locator('.ProseMirror:visible')
  const chooser = () => page.getByRole('combobox', { name: 'Tinto folder' })
  async function openDialog(path) {
    await fixture.app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: !target, filePaths: target ? [target] : [] })
    }, path)
  }
  async function saveDialog(path) {
    await fixture.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.lastDefaultPath = options.defaultPath
        return { canceled: !target, filePath: target || '' }
      }
    }, path)
  }

  await welcome().waitFor()
  await openDialog(null)
  await button('Choose folder').click()
  assert.equal((await library()).folder, null)
  assert.equal(await editor().count(), 0)
  assert.ok(!(await readdir(profile)).includes('Projects'))
  await fixture.close()
  page = await fixture.launch()
  await welcome().waitFor()

  await openDialog(folder)
  await button('Choose folder').click()
  await button('Open sample project').waitFor()
  assert.deepEqual(await readdir(folder), [])
  assert.equal((await library()).workspace, null)
  const firstFile = join(folder, 'First.tinto')
  await saveDialog(firstFile)
  await button('New project').click()
  await editor().waitFor()
  assert.equal(await fixture.app.evaluate(() => globalThis.lastDefaultPath), join(folder, 'Untitled.tinto'))
  await editor().click()
  await page.keyboard.insertText('Words in the first project.')
  await button('Home').click()

  await saveDialog(null)
  await button('New folder').click()
  assert.equal((await library()).workspace.path, firstFile)
  const second = join(directory, 'My other folder')
  await saveDialog(second)
  await button('New folder').click()
  await button('Open sample project').waitFor()
  assert.ok((await stat(second)).isDirectory())
  assert.equal(await chooser().inputValue(), second)
  assert.deepEqual(await readdir(second), [])

  const secondFile = join(second, 'Second.tinto')
  await saveDialog(secondFile)
  await button('New project').click()
  await editor().waitFor()
  assert.equal(await fixture.app.evaluate(() => globalThis.lastDefaultPath), join(second, 'Untitled.tinto'))
  await editor().click()
  await page.keyboard.insertText('Words in the second project.')
  await button('Home').click()
  await chooser().selectOption(folder)
  await page.waitForFunction(async path => (await window.tinto.library()).workspace?.path === path, firstFile)
  assert.match(JSON.stringify((await library()).workspace.project.documents[0].manuscript), /Words in the first project/)

  const discovered = join(directory, 'Previously created folder')
  await mkdir(discovered)
  const discoveredFile = join(discovered, 'An existing manuscript.tinto')
  await copyFile(firstFile, discoveredFile)
  await openDialog(discovered)
  await button('Choose folder').click()
  await page.getByTitle(discoveredFile, { exact: true }).click()
  await page.locator('#home .document-list').getByRole('button', { name: 'First', exact: true }).click()
  await editor().waitFor()
  assert.match(await editor().innerText(), /Words in the first project/)
  await fixture.close()
  page = await fixture.launch()
  await editor().waitFor()
  const reopened = await library()
  assert.equal(reopened.folder, discovered)
  assert.equal(reopened.workspace.path, discoveredFile)
  assert.deepEqual([...reopened.folders].sort(), [folder, second, discovered].sort())
  await button('Home').click()
  await chooser().selectOption(second)
  await page.waitForFunction(async path => (await window.tinto.library()).workspace?.path === path, secondFile)
  assert.match(JSON.stringify((await library()).workspace.project.documents[0].manuscript), /Words in the second project/)
})
