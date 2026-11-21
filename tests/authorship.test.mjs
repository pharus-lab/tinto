import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
// Puts the caret at the end of a paragraph, whatever its line wrapping.
async function toEnd(paragraph) {
  await paragraph.click()
  await paragraph.evaluate(el => {
    getSelection().collapse(el, el.childNodes.length)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

test('pasted and imported text keep their origin, typing is the writer’s own, and the record survives a restart', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  let prose = page.locator('.ProseMirror:visible')
  const documentId = await page.evaluate(async () => (await window.tinto.workspace()).project.documents[0].id)

  // Typed at the end of the first paragraph, then text pasted from another app.
  await toEnd(prose.locator('p').first())
  await page.keyboard.type(' The kettle was warm.')
  await fixture.app.evaluate(({ clipboard }) => clipboard.writeText(' A line from a letter.'))
  await page.keyboard.press(mod + '+v')
  const pasted = prose.locator('p').first().locator('[data-origin=pasted]')
  assert.deepEqual(await pasted.allTextContents(), [' A line from a letter.'])
  // A correction typed inside the pasted passage is the writer's own.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  assert.deepEqual(await pasted.allTextContents(), [' A line from a lett', 'er.'])
  assert.match(await prose.locator('p').first().textContent(), /The kettle was warm\. A line from a lettXer\.$/)

  // Copying within Tinto keeps where the words came from.
  await pasted.first().locator('text=line').dblclick().catch(async () => { await pasted.first().dblclick() })
  await page.keyboard.press(mod + '+c')
  await toEnd(prose.locator('p').nth(2))
  await page.keyboard.press(mod + '+v')
  assert.equal(await prose.locator('p').nth(2).locator('[data-origin=pasted]').count(), 1)

  // Show origins tints them quietly, and is remembered.
  const toggle = button(page, 'Show pasted and imported text')
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
  assert.equal(await pasted.first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
  assert.notEqual(await pasted.first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')

  // After a restart the origins and the record of the typing are still there.
  await fixture.close()
  page = await fixture.open()
  prose = page.locator('.ProseMirror:visible')
  assert.equal(await button(page, 'Show pasted and imported text').getAttribute('aria-pressed'), 'true')
  assert.equal(await prose.locator('p').first().locator('[data-origin=pasted]').count(), 2)
  const record = await page.evaluate(id => window.tinto.authorship(id, null), documentId)
  assert.equal(record.typed, 22)
  assert.equal(record.intact, true)
  assert.ok(record.characters.pasted > 20 && record.characters.written > 400)
  assert.equal(record.author, null)

  // Imported text is marked as imported.
  const file = join(fixture.directory, 'Letter.txt')
  await writeFile(file, 'Dear Mara,\nThe pear tree is in flower.')
  await fixture.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, file)
  await button(page, 'Home').click()
  await button(page, 'Import file').click()
  await page.locator('#tabs .current').filter({ hasText: 'Letter' }).waitFor()
  prose = page.locator('.ProseMirror:visible')
  assert.deepEqual(await prose.locator('[data-origin=imported]').allTextContents(), ['Dear Mara,', 'The pear tree is in flower.'])
  const imported = await page.evaluate(async () => {
    const doc = (await window.tinto.workspace()).project.documents.find(item => item.title === 'Letter')
    return window.tinto.authorship(doc.id, null)
  })
  assert.deepEqual(imported.characters, { written: 0, pasted: 0, imported: 37, ai: 0 })
})
