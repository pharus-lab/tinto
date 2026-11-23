import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { desktopFixture } from './desktop-fixture.mjs'

const bundle = await build({ stdin: { contents: "export * from './src/fonts'; export * from './src/typography'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
const { FontLibrary, readFace, listCharacters, manuscriptCharacters, fontStack } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const liberation = style => join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-' + style + '.ttf')
const styles = ['Regular', 'Bold', 'Italic', 'BoldItalic']
const button = (scope, name) => scope.getByRole('button', { name, exact: true })

test('a font is read for its family, weight and style, and checked against every character used', async t => {
  const text = 'Mañana —dijo— “sí”.\t漢'
  const face = readFace(new Uint8Array(await readFile(liberation('BoldItalic'))), '/fonts/LiberationSans-BoldItalic.ttf', text)
  assert.deepEqual([face.family, face.weight, face.style, face.name], ['Liberation Sans', '700', 'italic', 'LiberationSans-BoldItalic.ttf'])
  assert.match(face.file, /^[0-9a-f]{32}\.ttf$/)
  assert.deepEqual(face.missing, ['漢'], 'spaces and tabs are not drawn, everything else is checked')
  assert.throws(() => readFace(new TextEncoder().encode('not a font'), 'notes.ttf', text), /not a font Tinto can read/)
  assert.throws(() => readFace(new Uint8Array(4), 'notes.pdf', text), /not a TTF, OTF, WOFF or WOFF2 font/)
  assert.equal(listCharacters(['漢', '́', ...'abcdefghijklm']), '漢 U+0301 a b c d e f g h i j and 3 more')

  // Characters come from every wording, chosen or not.
  const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'ab' }, { type: 'choice', attrs: { id: 'c', active: 'o2', options: [{ id: 'o1', content: [{ type: 'text', text: 'ñ' }] }, { id: 'o2' }] }, content: [{ type: 'text', text: 'b漢' }] }] }] }
  assert.deepEqual([...manuscriptCharacters([doc])].sort(), ['a', 'b', 'ñ', '漢'].sort())

  // The library keeps one family with its four styles, replaces a style added again, and removes unused files.
  const dir = await mkdtemp(join(tmpdir(), 'tinto-fonts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const library = new FontLibrary(join(dir, 'fonts'))
  const read = async style => readFace(new Uint8Array(await readFile(liberation(style))), liberation(style), text)
  let fonts = await library.add([await read('Regular'), await read('Bold')])
  fonts = await library.add([await read('Italic'), await read('BoldItalic'), await read('Regular')])
  assert.equal(fonts.length, 1)
  assert.deepEqual(fonts[0].faces.map(item => item.weight + ' ' + item.style), ['400 italic', '700 italic', '400 normal', '700 normal'])
  assert.equal((await readdir(join(dir, 'fonts'))).length, 4)
  assert.deepEqual(await library.check(fonts[0].id, 'abc漢😀'), { family: 'Liberation Sans', missing: ['漢', '😀'] })
  assert.equal(await library.bytes('../secret.ttf'), null)
  assert.match(fontStack('user:' + fonts[0].id), /^"Tinto font [0-9a-f]{12}", var\(--book-serif\)$/)
  assert.equal(fontStack('user:not-an-id'), 'var(--book-serif)')
  assert.deepEqual(await library.remove(fonts[0].id), [])
  assert.deepEqual(await readdir(join(dir, 'fonts')), [])
})

test('the writer picks a theme and a manuscript font, Tinto checks the font against the project, and both survive a restart', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  let modal = page.getByRole('dialog')
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const manuscriptFont = () => page.locator('#editors').evaluate(el => getComputedStyle(el).fontFamily)

  await page.locator('#settings').click()
  const themes = modal.getByRole('radiogroup', { name: 'Theme' })
  assert.deepEqual(await themes.getByRole('radio').evaluateAll(items => items.map(item => item.value)), ['tinto', 'sepia', 'newsprint', 'fountain', 'contrast'])
  assert.equal(await themes.getByRole('radio', { name: 'Tinto' }).isChecked(), true)
  await modal.getByRole('combobox', { name: 'Appearance' }).selectOption('light')
  await themes.getByText('Sepia').click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sepia')
  assert.equal(await paper(), 'rgb(245, 237, 220)')
  await modal.getByRole('combobox', { name: 'Appearance' }).selectOption('dark')
  assert.equal(await paper(), 'rgb(33, 27, 20)')
  // Arrow keys move through the themes, as in any radio group.
  await themes.getByRole('radio', { name: 'Sepia' }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'newsprint')

  const font = modal.getByLabel('Manuscript font', { exact: true })
  assert.deepEqual(await font.locator('option').allInnerTexts(), ['Book serif', 'Georgia', 'Palatino', 'Charter', 'System sans', 'Monospace'])
  await font.selectOption('georgia')
  assert.match(await manuscriptFont(), /^Georgia/)
  assert.match(await modal.locator('.font-status').innerText(), /A font on this computer/)

  // Adding a family: all four styles, checked against the sample project.
  const picks = []
  await fixture.app.evaluate(({ dialog }, files) => {
    globalThis.fontPicks = files
    globalThis.messages = []
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.fontPicks.shift() })
    dialog.showMessageBox = async (window, options) => { globalThis.messages.push(options.message + ' | ' + options.detail.split('\n')[0]); return { response: globalThis.answer ?? 0 } }
  }, [styles.map(liberation), [join(fixture.directory, 'notes.ttf')], [liberation('Regular')], [liberation('Regular')]])
  await writeFile(join(fixture.directory, 'notes.ttf'), 'not a font')
  await button(modal, 'Add font…').click()
  await modal.locator('.font-status').getByText('Added. “Liberation Sans” (4 styles) draws every character in this project.').waitFor()
  assert.equal(await font.inputValue(), await font.locator('option', { hasText: 'Liberation Sans' }).getAttribute('value'))
  assert.match(await manuscriptFont(), /^"Tinto font [0-9a-f]{12}"/)
  assert.equal(await page.evaluate(async family => (await document.fonts.load('italic 700 21px "' + family + '"')).length, (await manuscriptFont()).split('"')[1]), 1, 'the file is served to the page')
  await button(modal, 'Add font…').click()
  await modal.locator('.font-status').getByText('notes.ttf is not a font Tinto can read. Choose TTF, OTF, WOFF or WOFF2 files.').waitFor()
  await button(modal, 'Close dialog').click()

  // A character the font lacks is reported before adding, and when the project opens.
  const first = page.locator('.ProseMirror:visible p').first()
  await first.click()
  await first.evaluate(el => { getSelection().collapse(el, el.childNodes.length); document.dispatchEvent(new Event('selectionchange')) })
  await page.keyboard.insertText(' 漢')
  await page.locator('#settings').click()
  await modal.locator('.font-status').getByText('“Liberation Sans” cannot draw 1 character in this project: 漢. They appear in a fallback font.').waitFor()
  await button(modal, 'Add font…').click()
  await page.waitForFunction(() => !document.querySelector('.font-status')?.closest('dialog')?.querySelector('button:disabled'))
  assert.deepEqual(await fixture.app.evaluate(() => globalThis.messages), ['“Liberation Sans” cannot draw 1 character used in this project. | 漢'])
  await fixture.app.evaluate(() => { globalThis.answer = 1 })
  await button(modal, 'Add font…').click()
  await modal.locator('.font-status').getByText(/^Added\. “Liberation Sans”/).waitFor()
  await button(modal, 'Close dialog').click()

  await fixture.close()
  page = await fixture.open()
  modal = page.getByRole('dialog')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'newsprint')
  assert.equal(await paper(), 'rgb(27, 28, 30)')
  assert.match(await manuscriptFont(), /^"Tinto font [0-9a-f]{12}"/)
  await page.locator('#notice').getByText('“Liberation Sans” cannot draw 1 character in this project: 漢. They appear in a fallback font.').waitFor()

  await page.locator('#settings').click()
  await button(modal, 'Remove font').click()
  await modal.locator('.font-status').getByText('Removed “Liberation Sans”. The manuscript uses Book serif.').waitFor()
  assert.match(await manuscriptFont(), /^"?Iowan Old Style/)
  assert.equal(await modal.getByLabel('Manuscript font', { exact: true }).locator('option', { hasText: 'Liberation Sans' }).count(), 0)
})

// Restricted license: OS/2 fsType bit 1 set, so documents may not carry the font.
function restricted(bytes) {
  const copy = Buffer.from(bytes)
  const tables = copy.readUInt16BE(4)
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16
    if (copy.toString('latin1', at, at + 4) === 'OS/2') { copy.writeUInt16BE(0x0002, copy.readUInt32BE(at + 8) + 8); return new Uint8Array(copy) }
  }
  throw Error('No OS/2 table')
}
// How LibreOffice reads a Word font key: hex pairs from the end of the GUID.
function deobfuscate(bytes, key) {
  const positions = [35, 33, 31, 29, 27, 25, 22, 20, 17, 15, 12, 10, 7, 5, 3, 1]
  const digits = positions.map(at => parseInt(key.slice(at, at + 2), 16))
  const out = Buffer.from(bytes)
  for (let i = 0; i < 16; i++) { out[i] ^= digits[i]; out[i + 16] ^= digits[i] }
  return out
}

test('a font the writer added is embedded in Word only when its license allows, under the key Word expects', async t => {
  const fonts = await build({ stdin: { contents: "export * from './src/fonts'; export * from './src/export-font'; export { writeDocx } from './src/exchange'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false })
  const { FontLibrary, readFace, docxFont, fontNote, systemExportFont, writeDocx } = await import('data:text/javascript;base64,' + Buffer.from(fonts.outputFiles[0].contents).toString('base64'))
  const { unzipSync, strFromU8 } = await import('fflate')
  const dir = await mkdtemp(join(tmpdir(), 'tinto-export-fonts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Fonts on this computer are named, never embedded.
  const book = systemExportFont('book')
  assert.deepEqual([book.family, book.faces.length, book.embeddable], ['Iowan Old Style', 0, false])
  assert.match(book.stack, /^'Iowan Old Style', .*serif$/)
  assert.equal(systemExportFont('sans').generic, 'sans-serif')
  assert.equal(fontNote(book, 'docx'), null)

  const library = new FontLibrary(join(dir, 'fonts'))
  const read = async style => readFace(new Uint8Array(await readFile(liberation(style))), liberation(style), '')
  const [added] = await library.add(await Promise.all(styles.map(read)))
  const font = await library.exportFont('user:' + added.id)
  assert.deepEqual([font.family, font.generic, font.embeddable, font.faces.length, font.faces.every(face => face.truetype)], ['Liberation Sans', 'sans-serif', true, 4, true])
  assert.equal((await library.exportFont('user:000000000000')).family, 'Iowan Old Style', 'a removed font falls back to Book serif')

  const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'Mañana' }] }] }
  const word = docxFont(font)
  assert.deepEqual(word.embedded.map(item => item.slot), ['Regular', 'Bold', 'Italic', 'BoldItalic'])
  const parts = unzipSync(writeDocx(doc, word))
  assert.match(strFromU8(parts['word/styles.xml']), /<w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans" w:cs="Liberation Sans"\/>/)
  const table = strFromU8(parts['word/fontTable.xml'])
  assert.match(table, /<w:font w:name="Liberation Sans"><w:family w:val="swiss"\/><w:pitch w:val="variable"\/><w:embedRegular r:id="rIdFont1" w:fontKey="\{[0-9A-F-]{36}\}"\/>/)
  assert.match(strFromU8(parts['word/settings.xml']), /<w:embedTrueTypeFonts\/>/)
  assert.match(strFromU8(parts['[Content_Types].xml']), /Extension="odttf" ContentType="application\/vnd\.openxmlformats-officedocument\.obfuscatedFont"/)
  assert.match(strFromU8(parts['word/_rels/fontTable.xml.rels']), /Target="fonts\/font4\.odttf"/)
  const regular = new Uint8Array(await readFile(liberation('Regular')))
  const key = /w:fontKey="([^"]+)"/.exec(table)[1]
  assert.notDeepEqual(parts['word/fonts/font1.odttf'].subarray(0, 32), regular.subarray(0, 32))
  assert.ok(deobfuscate(parts['word/fonts/font1.odttf'], key).equals(Buffer.from(regular)))
  assert.equal(fontNote(font, 'docx'), null)
  assert.match(fontNote(font, 'odt'), /^“Liberation Sans” is named in the file but not embedded, because Tinto embeds fonts only in PDF, Word, EPUB and HTML files\./)

  // A restricted font is named, and the writer is told why.
  const locked = new FontLibrary(join(dir, 'locked'))
  const [lockedFont] = await locked.add([readFace(restricted(regular), 'Locked.ttf', '')])
  const named = await locked.exportFont('user:' + lockedFont.id)
  assert.equal(named.embeddable, false)
  assert.deepEqual(docxFont(named).embedded, [])
  const plain = unzipSync(writeDocx(doc, docxFont(named)))
  assert.equal(Object.keys(plain).some(name => name.startsWith('word/fonts/')), false)
  assert.doesNotMatch(strFromU8(plain['word/settings.xml']), /embedTrueTypeFonts/)
  assert.match(fontNote(named, 'docx'), /because its license does not allow it\. Readers without it see another font\.$/)
  // Without a font, Word documents stay in Georgia.
  assert.match(strFromU8(unzipSync(writeDocx(doc))['word/styles.xml']), /w:ascii="Georgia"/)
})

test('exports are set in the manuscript font: embedded in PDF, Word, EPUB and HTML, named in ODT and RTF', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const modal = page.getByRole('dialog')
  const { unzipSync, strFromU8 } = await import('fflate')
  await fixture.app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, styles.map(liberation))
  await page.locator('#settings').click()
  await modal.getByRole('tab', { name: 'Appearance' }).click()
  await button(modal, 'Add font…').click()
  await modal.locator('.font-status').getByText(/^Added\. “Liberation Sans” \(4 styles\)/).waitFor()
  await button(modal, 'Close dialog').click()

  const output = join(fixture.directory, 'exports')
  await mkdir(output)
  const notices = {}
  async function exportAs(extension, label) {
    const path = join(output, 'Kitchen.' + extension)
    await fixture.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, path)
    await button(page, 'Export').click()
    await button(modal, label + ' (.' + extension + ')').click()
    const notice = page.locator('#notice').filter({ hasText: 'as ' + extension.toUpperCase() + '.' })
    await notice.waitFor()
    notices[extension] = await notice.innerText()
    return readFile(path)
  }
  const pdf = await exportAs('pdf', 'PDF')
  assert.match(pdf.toString('latin1'), /\/FontName \/[A-Z]{6}\+LiberationSans/, 'the PDF carries the font')

  const docx = unzipSync(await exportAs('docx', 'Word document'))
  assert.match(strFromU8(docx['word/styles.xml']), /w:ascii="Liberation Sans"/)
  assert.equal(Object.keys(docx).filter(name => name.endsWith('.odttf')).length, 4)

  const epub = unzipSync(await exportAs('epub', 'EPUB'))
  const fontFiles = Object.keys(epub).filter(name => /^EPUB\/fonts\/[0-9a-f]{32}\.ttf$/.test(name))
  assert.equal(fontFiles.length, 4)
  const css = strFromU8(epub[Object.keys(epub).find(name => name.endsWith('.css'))])
  assert.match(css, /@font-face \{ font-family: "Liberation Sans"; src: url\("\.\.\/fonts\/[0-9a-f]{32}\.ttf"\) format\("truetype"\); font-weight: 700; font-style: italic; \}/)
  assert.match(css, /body \{ font-family: "Liberation Sans", 'Iowan Old Style'/)
  assert.equal((strFromU8(epub['EPUB/content.opf']).match(/media-type="font\/ttf"/g) ?? []).length, 4)
  assert.equal(strFromU8(epub.mimetype), 'application/epub+zip')

  const html = (await exportAs('html', 'HTML')).toString()
  assert.match(html, /@font-face \{ font-family: "Liberation Sans"; src: url\("data:font\/ttf;base64,/)
  assert.match(html, /font: 12pt\/1\.333 "Liberation Sans", 'Iowan Old Style'/)

  const odt = unzipSync(await exportAs('odt', 'OpenDocument text'))
  const odtStyles = strFromU8(odt['styles.xml'])
  assert.match(odtStyles, /<style:font-face style:name="Liberation Sans" svg:font-family="&#39;Liberation Sans&#39;" style:font-family-generic="swiss"/)
  assert.doesNotMatch(odtStyles, /style:font-name="(Times New Roman|Arial)"/)
  const rtf = (await exportAs('rtf', 'Rich text')).toString('latin1')
  assert.match(rtf, /\{\\fonttbl\{\\f0 \\fswiss Liberation Sans;\}/)

  for (const extension of ['pdf', 'docx', 'epub', 'html']) assert.doesNotMatch(notices[extension], /not embedded/, extension)
  for (const extension of ['odt', 'rtf']) assert.match(notices[extension], /“Liberation Sans” is named in the file but not embedded, because Tinto embeds fonts only in PDF, Word, EPUB and HTML files\./)
})
