import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const button = (scope, name) => scope.getByRole('button', { name, exact: true })

function representativeDocx(template) {
  const files = unzipSync(template)
  files['word/styles.xml'] = strToU8('<w:styles xmlns:w="' + word + '"><w:style w:styleId="ChapterStyle" w:type="paragraph"><w:name w:val="heading 2"/></w:style><w:style w:styleId="Emphasis" w:type="character"><w:rPr><w:i/></w:rPr></w:style><w:style w:styleId="Hyperlink" w:type="character"><w:rPr><w:u w:val="single"/></w:rPr></w:style></w:styles>')
  files['word/document.xml'] = strToU8(`<w:document xmlns:w="${word}"><w:body>
    <w:p><w:pPr><w:pStyle w:val="ChapterStyle"/></w:pPr><w:r><w:t>The letter</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>Monday</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:shd w:val="clear" w:fill="F2D88F"/></w:rPr><w:t>Earlier Tinto highlight</w:t></w:r></w:p>
    <w:p><w:r><w:t>See </w:t></w:r><w:hyperlink><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the notes</w:t></w:r></w:hyperlink><w:r><w:t> online.</w:t></w:r></w:p>
    <w:p><w:commentRangeStart w:id="0"/><w:del><w:r><w:delText>Discarded revision</w:delText></w:r></w:del><w:ins><w:r><w:t>Accepted revision</w:t></w:r></w:ins><w:commentRangeEnd w:id="0"/></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>`)
  return zipSync(files)
}

test('local import and export preserve active prose, headings and author formatting', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const { app, directory } = fixture
  const output = process.env.TINTO_EXCHANGE_OUTPUT ?? directory
  await mkdir(output, { recursive: true })
  const prose = page.locator('#editors .ProseMirror:visible')
  await button(page, 'Headings').click()
  await button(page.locator('#heading-list'), 'Create spawn for The kitchen').click()
  await prose.locator('[data-choice-id="kitchen-food"]').click()
  const nested = page.getByRole('region', { name: 'Within this passage' })
  await button(nested, 'Edit in manuscript').click()
  for (const mark of ['Bold', 'Italic', 'Underline']) await button(page, mark).click()
  const underlined = prose.locator('.wording .reviewed-wording u')
  assert.equal(await underlined.textContent(), 'cake')
  const shortcut = process.platform === 'darwin' ? 'Meta+u' : 'Control+u'
  await page.keyboard.press(shortcut)
  await underlined.waitFor({ state: 'detached' })
  await page.keyboard.press(shortcut)
  await underlined.waitFor()
  assert.equal(await button(page, 'Underline').getAttribute('aria-pressed'), 'true')
  const paths = { docx: join(output, 'Kitchen excerpt.docx'), pdf: join(output, 'Kitchen excerpt.pdf') }

  async function exportAs(extension, label) {
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, paths[extension])
    await button(page, 'Export').click()
    await button(page.getByRole('dialog'), label).click()
    await page.locator('#notice').filter({ hasText: 'as ' + extension.toUpperCase() + '.' }).waitFor()
  }
  async function importPath(filePath) {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, filePath)
    await button(page, 'Home').click()
    await button(page, 'Import file').click()
  }

  await exportAs('docx', 'Word document (.docx)')
  await exportAs('pdf', 'PDF (.pdf)')
  const docx = await readFile(paths.docx)
  const xml = strFromU8(unzipSync(docx)['word/document.xml'])
  assert.match(xml, /<w:u w:val="single"\/>/)
  assert.doesNotMatch(xml, /<w:highlight|F2D88F/)
  assert.match(xml, /Heading1/)
  assert.match(xml, /cake/)
  assert.doesNotMatch(xml, /a cat|ice cream|The garden|F4E5E6|wording|misspelling|history/i)
  await importPath(paths.docx)
  await page.locator('#tabs .current').filter({ hasText: 'Kitchen excerpt' }).waitFor()
  assert.equal(await prose.locator('h1').textContent(), 'The kitchen')
  assert.equal(await prose.locator('strong em u').textContent(), 'cake')

  await importPath(paths.pdf)
  let notes = page.getByRole('dialog', { name: 'Import notes' })
  await notes.getByText(/reading order/).waitFor()
  await button(notes, 'Done').click()
  assert.match(await prose.innerText(), /I want to eat cake\./)
  assert.doesNotMatch(await prose.innerText(), /ice cream|a cat|The garden/)

  const sourcePath = join(directory, 'Letter.docx')
  const source = representativeDocx(docx)
  await writeFile(sourcePath, source)
  await importPath(sourcePath)
  notes = page.getByRole('dialog', { name: 'Import notes' })
  for (const category of ['Table cells', 'Images', 'Comments', 'Tracked revisions']) await notes.getByText(category, { exact: false }).waitFor()
  await button(notes, 'Done').click()
  assert.equal(await prose.locator('h2').textContent(), 'The letter')
  assert.equal(await prose.locator('strong em u').textContent(), 'Monday')
  assert.equal(await prose.locator('u').filter({ hasText: 'Earlier Tinto highlight' }).textContent(), 'Earlier Tinto highlight')
  // A link's style underline is not the author's mark; its text arrives plain.
  assert.match(await prose.innerText(), /See the notes online\./)
  assert.equal(await prose.locator('u').filter({ hasText: 'the notes' }).count(), 0)
  assert.match(await prose.innerText(), /Accepted revision/)
  assert.match(await prose.innerText(), /A table cell/)
  assert.doesNotMatch(await prose.innerText(), /Discarded revision/)
  assert.deepEqual(await readFile(sourcePath), Buffer.from(source))

  const txt = join(directory, 'Lines.txt')
  await writeFile(txt, 'Uno.\r\n\r\nDos.')
  await importPath(txt)
  await page.locator('#tabs .current').filter({ hasText: 'Lines' }).waitFor()
  assert.deepEqual(await prose.locator('p').allTextContents(), ['Uno.', '', 'Dos.'])

  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.getContext('2d').fillText('Photograph of a page', 10, 20)
    return canvas.toDataURL()
  })
  const scan = await app.evaluate(async ({ BrowserWindow }, data) => {
    const source = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await source.loadURL('data:text/html,' + encodeURIComponent('<img src="' + data + '">'))
      return [...await source.webContents.printToPDF({})]
    } finally { source.destroy() }
  }, image)
  const scanPath = join(directory, 'Scanned page.pdf')
  await writeFile(scanPath, Buffer.from(scan))
  await importPath(scanPath)
  await page.locator('#notice').filter({ hasText: /OCR/ }).waitFor()
  assert.equal(await page.locator('#tabs .current').innerText(), 'Home')
})
