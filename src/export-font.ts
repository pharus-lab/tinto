import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { ExportFormat } from './exchange'
import { SYSTEM_FONTS } from './typography'

// The manuscript font as an exported file carries it. A font on this computer
// is named; a font the writer added is also embedded where the format can carry
// it and the font's license allows it.
export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2'
export interface ExportFace { file: string; format: FontFormat; weight: string; italic: boolean; bytes: Uint8Array; truetype: boolean }
export interface ExportFont {
  family: string
  // Word processors take one name and try the others for a substitute.
  names: string[]
  stack: string
  generic: 'serif' | 'sans-serif' | 'monospace'
  faces: ExportFace[]
  // Its license allows documents that can be edited to carry it.
  embeddable: boolean
}

// The same stack as --book-serif in styles.css.
export const BOOK_SERIF = "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
const SYSTEM_NAMES: Record<string, [string[], ExportFont['generic']]> = {
  book: [['Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', 'Georgia'], 'serif'],
  georgia: [['Georgia', 'Times New Roman'], 'serif'],
  palatino: [['Palatino', 'Palatino Linotype', 'Book Antiqua'], 'serif'],
  charter: [['Charter', 'Bitstream Charter', 'Sitka Text', 'Cambria'], 'serif'],
  sans: [['Helvetica Neue', 'Segoe UI', 'Arial'], 'sans-serif'],
  mono: [['Menlo', 'Consolas', 'Courier New'], 'monospace']
}
export function systemExportFont(choice: string): ExportFont {
  const id = SYSTEM_NAMES[choice] ? choice : 'book'
  const [names, generic] = SYSTEM_NAMES[id]
  const stack = SYSTEM_FONTS.find(([key]) => key === id)![2].replace('var(--book-serif)', BOOK_SERIF)
  return { family: names[0], names, stack, generic, faces: [], embeddable: false }
}

const cssString = (value: string) => '"' + value.replace(/[\\"\n\r]/g, char => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"'
const attribute = (value: string) => value.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';')
export const addedFontStack = (family: string) => cssString(family) + ', ' + BOOK_SERIF
const MEDIA: Record<FontFormat, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }
const CSS_FORMAT: Record<FontFormat, string> = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }
export const dataURL = (face: ExportFace) => 'data:' + MEDIA[face.format] + ';base64,' + Buffer.from(face.bytes).toString('base64')

// One @font-face per style, each file found where src says.
export function fontFaces(font: ExportFont, src: (face: ExportFace) => string): string {
  return font.faces.map(face => '@font-face { font-family: ' + cssString(font.family) + '; src: url("' + src(face) + '") format("' + CSS_FORMAT[face.format] + '"); '
    + 'font-weight: ' + (/^\d{1,4}( \d{1,4})?$/.test(face.weight) ? face.weight : '400') + '; font-style: ' + (face.italic ? 'italic' : 'normal') + '; }').join('\n')
}

// Word documents embed TrueType fonts obfuscated with a key (ECMA-376 Part 1,
// 17.8.1): the first 32 bytes are combined with the key's bytes in reverse order.
export function obfuscateFont(bytes: Uint8Array, key: string): Uint8Array {
  const hex = key.replace(/[{}-]/g, '')
  const out = bytes.slice()
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= parseInt(hex.substr(30 - 2 * (i % 16), 2), 16)
  return out
}
export type DocxSlot = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic'
export interface DocxFont { names: string[]; generic: ExportFont['generic']; embedded: { slot: DocxSlot; key: string; bytes: Uint8Array }[] }
// Word has four slots per family; each takes the closest TrueType style.
export function docxFont(font: ExportFont): DocxFont {
  const embedded: DocxFont['embedded'] = []
  const slots: [DocxSlot, boolean, boolean][] = [['Regular', false, false], ['Bold', true, false], ['Italic', false, true], ['BoldItalic', true, true]]
  if (font.embeddable) for (const [slot, bold, italic] of slots) {
    const target = bold ? 700 : 400
    const face = font.faces.filter(face => face.truetype && face.italic === italic && (parseInt(face.weight) >= 600) === bold)
      .sort((a, b) => Math.abs(parseInt(a.weight) - target) - Math.abs(parseInt(b.weight) - target))[0]
    if (!face) continue
    const key = '{' + crypto.randomUUID().toUpperCase() + '}'
    embedded.push({ slot, key, bytes: obfuscateFont(face.bytes, key) })
  }
  return { names: font.names, generic: font.generic, embedded }
}

// A packaged document keeps its mimetype first and uncompressed (ODF, EPUB).
function repack(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const entries: Zippable = {}
  if (files.mimetype) entries.mimetype = [files.mimetype, { level: 0 }]
  for (const [name, bytes] of Object.entries(files)) if (name !== 'mimetype') entries[name] = bytes
  return zipSync(entries)
}

// pandoc writes ODT in Times New Roman and Arial; the manuscript font replaces both.
export function odtWithFont(bytes: Uint8Array, font: ExportFont): Uint8Array {
  const files = unzipSync(bytes)
  const name = attribute(font.family)
  const generic = { serif: 'roman', 'sans-serif': 'swiss', monospace: 'modern' }[font.generic]
  const declaration = '<style:font-face style:name="' + name + '" svg:font-family="' + attribute("'" + font.family.replace(/'/g, '') + "'") + '" style:font-family-generic="' + generic + '" style:font-pitch="' + (font.generic === 'monospace' ? 'fixed' : 'variable') + '" />'
  for (const part of ['styles.xml', 'content.xml']) {
    if (!files[part]) continue
    let text = strFromU8(files[part]).replace('<office:font-face-decls>', '<office:font-face-decls>' + declaration)
    if (part === 'styles.xml') text = text.replace(/style:font-name="(Times New Roman|Arial)"/g, 'style:font-name="' + name + '"')
    files[part] = strToU8(text)
  }
  return repack(files)
}

// pandoc's RTF has one text font, \f0.
export function rtfWithFont(bytes: Uint8Array, font: ExportFont): Uint8Array {
  const kind = { serif: 'froman', 'sans-serif': 'fswiss', monospace: 'fmodern' }[font.generic]
  // RTF is ASCII: other characters are written as signed 16-bit \u codes.
  let name = ''
  // A semicolon would end the name in the font table, so it is left out.
  const plain = font.family.replace(/;/g, '')
  for (let i = 0; i < plain.length; i++) {
    const char = plain[i], code = plain.charCodeAt(i)
    name += /[\\{}]/.test(char) ? '\\' + char : code < 128 ? char : '\\u' + ((code << 16) >> 16) + '?'
  }
  const text = Buffer.from(bytes).toString('latin1').replace(/\{\\f0 \\f[a-z]+ [^;{}]*;\}/, () => '{\\f0 \\' + kind + ' ' + name + ';}')
  return new Uint8Array(Buffer.from(text, 'latin1'))
}

// pandoc's EPUB keeps its stylesheet; the font's files join the book, and the
// stylesheet gains the faces and the text font.
export function epubWithFont(bytes: Uint8Array, font: ExportFont, embed: boolean): Uint8Array {
  const files: Record<string, Uint8Array> = unzipSync(bytes)
  const opf = Object.keys(files).find(name => name.endsWith('.opf'))
  const stylesheet = Object.keys(files).find(name => name.endsWith('.css'))
  if (!opf || !stylesheet) return bytes
  const folder = opf.slice(0, opf.lastIndexOf('/') + 1)
  const faces = embed ? font.faces : []
  const items = faces.map((face, index) => {
    files[folder + 'fonts/' + face.file] = face.bytes
    return '<item id="tinto-font-' + (index + 1) + '" href="fonts/' + face.file + '" media-type="' + MEDIA[face.format] + '" />'
  })
  files[opf] = strToU8(strFromU8(files[opf]).replace('</manifest>', items.join('') + '</manifest>'))
  const relative = '../'.repeat(stylesheet.slice(folder.length).split('/').length - 1)
  const css = fontFaces({ ...font, faces }, face => relative + 'fonts/' + face.file) + '\nbody { font-family: ' + font.stack + '; }\n'
  files[stylesheet] = strToU8(strFromU8(files[stylesheet]) + '\n/* The manuscript font, from Tinto. */\n' + css)
  return repack(files)
}

// When a font the writer added is only named, the export says so.
export function fontNote(font: ExportFont, format: ExportFormat): string | null {
  if (!font.faces.length || format === 'pdf' || format === 'txt' || format === 'md') return null
  const name = '“' + font.family + '”'
  const why = format === 'odt' || format === 'rtf' ? 'Tinto embeds fonts only in PDF, Word, EPUB and HTML files'
    : !font.embeddable ? 'its license does not allow it'
      : format === 'docx' && !font.faces.some(face => face.truetype) ? 'Word files carry only TrueType fonts'
        : null
  return why && name + ' is named in the file but not embedded, because ' + why + '. Readers without it see another font.'
}
