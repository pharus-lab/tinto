import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  await modal.getByLabel('Appearance').selectOption('light')
  await themes.getByText('Sepia').click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sepia')
  assert.equal(await paper(), 'rgb(245, 237, 220)')
  await modal.getByLabel('Appearance').selectOption('dark')
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
