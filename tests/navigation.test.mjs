import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright'

test('linked sections share edits, the trail follows scrolling, and keyboard review works in both appearances', async t => {
  const executablePath = process.env.TINTO_PACKAGED_EXECUTABLE
  if (!executablePath) await import('../scripts/build.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'tinto-navigation-'))
  const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env: { ...process.env, TINTO_USER_DATA: directory } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await app.firstWindow()
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
  const executablePath = process.env.TINTO_PACKAGED_EXECUTABLE
  if (!executablePath) await import('../scripts/build.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'tinto-restored-copy-'))
  const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env: { ...process.env, TINTO_USER_DATA: directory } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await app.firstWindow()
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
