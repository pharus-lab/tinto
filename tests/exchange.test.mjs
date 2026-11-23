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
  const formats = { md: 'Markdown', html: 'HTML', rtf: 'Rich text', odt: 'OpenDocument text', epub: 'EPUB', txt: 'Plain text' }

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
  for (const [extension, label] of Object.entries(formats)) {
    paths[extension] = join(output, 'Kitchen ' + extension + '.' + extension)
    await exportAs(extension, label + ' (.' + extension + ')')
  }
  for (const extension of Object.keys(formats)) {
    await importPath(paths[extension])
    await page.locator('#tabs .current').filter({ hasText: 'Kitchen ' + extension }).waitFor()
    const text = await prose.innerText()
    assert.match(text, /I want to eat cake\./, extension)
    assert.doesNotMatch(text, /a cat|ice cream|The garden/, extension)
    if (extension !== 'txt') {
      assert.deepEqual(await prose.locator('h1').allTextContents(), ['The kitchen'], extension)
      assert.equal(await prose.locator('strong em u').textContent(), 'cake', extension)
    }
    assert.equal(await prose.locator('[data-origin="imported"]').first().count(), 1, extension)
  }
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

  const foreignFiles = {
    'Essays.markdown': 'Letters\n=======\n\nA **bold** word, an *italic* word, and <u>café</u>.',
    'Essays.htm': '<!doctype html><html><head><title>Window title</title></head><body><article><h1>Letters</h1><p>A <b>bold</b> word, an <i>italic</i> word, and <u>café</u>.</p><p>Next<br>line</p></article></body></html>',
    'Essays.rtf': String.raw`{\rtf1\ansi\ansicpg1252{\pard\outlinelevel0 Letters\par}{\pard A {\b bold} word, an {\i italic} word, and {\ul caf\'e9}.\par}{\pard \uc0\u-10179\u-8638  \uc1\u8220"I\u8221" said.\par}}`
  }
  for (const [name, contents] of Object.entries(foreignFiles)) {
    const path = join(directory, name)
    await writeFile(path, contents)
    await importPath(path)
    await page.locator('#tabs .current').filter({ hasText: 'Essays' }).waitFor()
    assert.equal(await prose.locator('h1').textContent(), 'Letters')
    assert.equal(await prose.locator('strong').textContent(), 'bold')
    assert.equal(await prose.locator('em').textContent(), 'italic')
    assert.equal(await prose.locator('u').textContent(), 'café')
    if (name.endsWith('.rtf')) assert.match(await prose.innerText(), /🙂 “I” said\./)
    if (name.endsWith('.htm')) assert.deepEqual((await prose.locator('p').allTextContents()).slice(1), ['Next', 'line'])
  }

  const chapters = zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'Book/book.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">letters</dc:identifier><dc:title>Letters</dc:title><dc:language>en</dc:language></metadata><manifest><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="z" href="text/z.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="z"/><itemref idref="a"/></spine></package>'),
    'Book/text/a.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Second letter</h1><p><em>Adiós.</em></p></body></html>'),
    'Book/text/z.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>First letter</h1><p>Hello.</p></body></html>')
  })
  const book = join(directory, 'Ordered chapters.epub')
  await writeFile(book, chapters)
  await importPath(book)
  await page.locator('#tabs .current').filter({ hasText: 'Ordered chapters' }).waitFor()
  assert.deepEqual(await prose.locator('h1').allTextContents(), ['First letter', 'Second letter'])
  assert.deepEqual(await prose.locator('p').allTextContents(), ['Hello.', 'Adiós.'])

  const namespaces = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"'
  const odt = zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'styles.xml': strToU8('<office:document-styles ' + namespaces + '><office:styles><style:style style:name="Underlined" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style></office:styles></office:document-styles>'),
    'content.xml': strToU8('<office:document-content ' + namespaces + '><office:automatic-styles><style:style style:name="Emphasis" style:family="text" style:parent-style-name="Underlined"><style:text-properties fo:font-style="italic"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="2">Second chapter</text:h><text:p>A<text:s text:c="2"/><text:span text:style-name="Emphasis">letter</text:span><text:line-break/>from Madrid.</text:p></office:text></office:body></office:document-content>')
  })
  const openDocument = join(directory, 'Styled manuscript.odt')
  await writeFile(openDocument, odt)
  await importPath(openDocument)
  await page.locator('#tabs .current').filter({ hasText: 'Styled manuscript' }).waitFor()
  assert.equal(await prose.locator('h2').textContent(), 'Second chapter')
  assert.deepEqual(await prose.locator('p').allTextContents(), ['A  letter', 'from Madrid.'])
  assert.equal(await prose.locator('em u').textContent(), 'letter')

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

test('Markdown source edits headings and emphasis, keeps alternatives, and opens imported Markdown by preference', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  const source = () => page.getByRole('textbox', { name: 'Markdown source', exact: true })
  const rich = () => page.getByRole('textbox', { name: 'Manuscript', exact: true })
  const toggle = () => button(page, 'Markdown')
  const setting = 'Automatically activate markdown editing for imported .md files'
  const end = async block => {
    await block.evaluate(el => {
      el.closest('[contenteditable=true]').focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
  }
  async function importText(name, text) {
    const path = join(fixture.directory, name)
    await writeFile(path, text)
    await fixture.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
    await button(page, 'Home').click()
    await button(page, 'Import file').click()
    await page.locator('#tabs .current').filter({ hasText: name.split('.')[0] }).waitFor()
  }
  const font = block => block.evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize])
  const headingText = async block => (await block.innerText()).trimEnd()
  assert.equal(await button(page, 'Underline').evaluate(el => el.nextElementSibling.textContent), 'Markdown')
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false')
  const titleFont = await font(rich().locator('h1').first())
  await toggle().click()
  const kitchen = source().locator('h1').first()
  await source().locator('p').first().click()
  assert.equal(await headingText(kitchen), 'The kitchen')
  assert.deepEqual(await font(kitchen), titleFont)
  await kitchen.click()
  assert.equal(await headingText(kitchen), '# The kitchen')
  assert.deepEqual(await font(kitchen), await font(source().locator('p').first()))
  await toggle().focus()
  assert.equal(await headingText(kitchen), 'The kitchen')
  await source().focus()
  assert.equal(await headingText(kitchen), '# The kitchen')
  await end(source().locator('p').first())
  await page.keyboard.insertText(' **Revised** and *checked*.')
  await button(page, 'Undo').click()
  assert.doesNotMatch(await source().textContent(), /Revised/)
  await button(page, 'Redo').click()
  assert.match(await source().textContent(), /\*\*Revised\*\*/)
  await toggle().click()
  assert.equal(await rich().locator('p strong').first().textContent(), 'Revised')
  assert.equal(await rich().locator('p em').first().textContent(), 'checked')
  assert.equal(await rich().locator('[data-choice-id="kitchen-food"]').textContent(), 'cake')
  await button(page, 'Headings').click()
  await button(page.locator('#heading-list'), 'Create spawn for The kitchen').click()
  await toggle().click()
  assert.equal(await source().locator('h1:visible').count(), 1)
  const first = source().locator('h1:visible')
  await first.evaluate(el => {
    el.closest('[contenteditable=true]').focus()
    window.getSelection().collapse(el.firstChild, 0)
  })
  await page.keyboard.insertText('#')
  await toggle().click()
  assert.equal(await rich().locator('h2:visible').textContent(), 'The kitchen')

  await importText('Default.md', '# Ordinary import\n\nAn __example__ with [a link](https://example.org).')
  await rich().waitFor()
  await toggle().click()
  assert.match(await source().textContent(), /__example__ with \[a link\]\(https:\/\/example.org\)/)
  await toggle().click()
  await button(page, 'Reading and project settings').click()
  await page.getByRole('tab', { name: 'Writing' }).click()
  const preference = page.getByRole('checkbox', { name: setting })
  assert.equal(await preference.isChecked(), false)
  await preference.check()
  await button(page, 'Close dialog').click()
  const original = 'Letters\n=======\n\n## *Dear* reader ##\n\nAn __imported__ letter with [a link](https://example.org).'
  await importText('Letters.MD', original)
  await source().waitFor()
  assert.match(await source().textContent(), /__imported__/)
  const letters = source().locator('h1')
  const subtitle = source().locator('h2')
  await letters.click()
  assert.equal(await headingText(letters), 'Letters\n=======')
  assert.equal(await headingText(subtitle), 'Dear reader')
  assert.equal(await subtitle.getByText('Dear', { exact: true }).evaluate(el => getComputedStyle(el).fontStyle), 'italic')
  await subtitle.click()
  assert.equal(await headingText(letters), 'Letters')
  assert.equal(await headingText(subtitle), '## *Dear* reader ##')
  await end(source().locator('p').last())
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('### A new ending')
  await button(page, 'Headings').click()
  await button(page.locator('#heading-list'), 'A new ending').click()
  assert.equal(await headingText(source().locator('h3')), '### A new ending')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.markdown-source h3')?.innerText.trimEnd() === 'A new ending')
  await toggle().click()
  assert.equal(await rich().locator('h1').textContent(), 'Letters')
  assert.equal(await rich().locator('h3').textContent(), 'A new ending')
  assert.equal(await rich().locator('strong').textContent(), 'imported')
  assert.equal(await rich().locator('strong [data-origin=imported], [data-origin=imported] strong').count(), 1)
  assert.equal(await rich().locator('h3 [data-origin]').count(), 0)
  await toggle().click()
  const path = join(fixture.directory, 'Edited.md')
  await fixture.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, path)
  await button(page, 'Export').click()
  await button(page, 'Markdown (.md)').click()
  await page.locator('#notice').filter({ hasText: 'as MD.' }).waitFor()
  assert.equal(await readFile(path, 'utf8'), original + '\n### A new ending')
  await fixture.close()
  page = await fixture.open()
  await source().waitFor()
  assert.equal(await source().locator('h3').textContent(), '### A new ending')
  await importText('Other.txt', 'Just text.')
  await rich().waitFor()
  await toggle().click()
  await source().focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await source().evaluate(el => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '## A pasted heading\nA **pasted** paragraph.')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  await toggle().click()
  assert.equal(await rich().locator('h2').textContent(), 'A pasted heading')
  assert.equal(await rich().locator('strong').textContent(), 'pasted')
  assert.equal(await rich().locator('h2 [data-origin=pasted]').textContent(), 'A pasted heading')
  await button(page, 'Reading and project settings').click()
  await page.getByRole('tab', { name: 'Writing' }).click()
  assert.equal(await page.getByRole('checkbox', { name: setting }).isChecked(), true)
})
