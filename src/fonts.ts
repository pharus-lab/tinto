import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { create, type Font } from 'fontkit'
import { addedFontStack, systemExportFont, type ExportFace, type ExportFont, type FontFormat } from './export-font'
import type { FontFaceFile, ManuscriptFont } from './project-types'

// Fonts the writer adds for the manuscript. Each file is read with fontkit,
// checked for every character the project uses, and kept in Tinto's folder
// under a name made from its content, so the app serves only files it checked.
export const FONT_FILE = /^[0-9a-f]{32}\.(ttf|otf|woff|woff2)$/
export const FONT_TYPES: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }
const LARGEST = 30 * 1024 * 1024

export interface ReadFace extends FontFaceFile { family: string; missing: string[]; bytes: Uint8Array }

// Spaces, line breaks and invisible formatting characters are not drawn by a font.
const drawn = (char: string) => !/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) && !/[\u{FE00}-\u{FE0F}]/u.test(char)

export function missingCharacters(font: Pick<Font, 'hasGlyphForCodePoint'>, characters: string): string[] {
  return [...new Set(characters)].filter(char => drawn(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!))
}


export function readFace(bytes: Uint8Array, name: string, characters: string): ReadFace {
  const ext = extname(name).slice(1).toLowerCase()
  if (!FONT_TYPES[ext]) throw Error(name + ' is not a TTF, OTF, WOFF or WOFF2 font.')
  if (bytes.byteLength > LARGEST) throw Error(name + ' is larger than 30 MB.')
  let font: ReturnType<typeof create>
  try { font = create(bytes) } catch { throw Error(name + ' is not a font Tinto can read. Choose TTF, OTF, WOFF or WOFF2 files.') }
  if ('fonts' in font) throw Error(name + ' is a font collection. Choose the separate TTF or OTF files of the family.')
  const family = (font.getName('preferredFamily') ?? font.familyName ?? '').replace(/[\x00-\x1f"\\]/g, '').trim()
  if (!family) throw Error(name + ' has no family name.')
  const os2 = font['OS/2']
  const subfamily = (font.getName('preferredSubfamily') ?? font.subfamilyName ?? '').toLowerCase()
  const italic = !!(os2?.fsSelection?.italic || os2?.fsSelection?.oblique || font.italicAngle || /italic|oblique/.test(subfamily))
  // A variable font covers a range of weights.
  const axis = font.variationAxes?.wght
  const weight = axis ? Math.round(axis.min) + ' ' + Math.round(axis.max) : String(Math.min(1000, Math.max(1, os2?.usWeightClass ?? 400)))
  const file = createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.' + ext
  return { family: family.slice(0, 80), file, weight, style: italic ? 'italic' : 'normal', name: basename(name), missing: missingCharacters(font, characters), bytes }
}

export class FontLibrary {
  private readonly index: string
  constructor(private readonly folder: string) { this.index = folder + '.json' }

  async list(): Promise<ManuscriptFont[]> {
    if (!existsSync(this.index)) return []
    try { return (JSON.parse(await readFile(this.index, 'utf8')) as ManuscriptFont[]).filter(font => font.faces.every(face => FONT_FILE.test(face.file))) }
    catch { return [] }
  }
  private async keep(fonts: ManuscriptFont[]) {
    await writeFile(this.index + '.tmp', JSON.stringify(fonts, null, 2))
    await rename(this.index + '.tmp', this.index)
  }

  // Faces of one family join it; a face already there is replaced.
  async add(faces: ReadFace[]): Promise<ManuscriptFont[]> {
    await mkdir(this.folder, { recursive: true })
    const fonts = await this.list()
    for (const face of faces) {
      await writeFile(join(this.folder, face.file), face.bytes)
      const id = createHash('sha256').update(face.family.toLowerCase()).digest('hex').slice(0, 12)
      let font = fonts.find(item => item.id === id)
      if (!font) fonts.push(font = { id, family: face.family, faces: [] })
      const entry: FontFaceFile = { file: face.file, weight: face.weight, style: face.style, name: face.name }
      font.faces = [...font.faces.filter(item => item.file !== face.file && !(item.weight === face.weight && item.style === face.style)), entry]
        .sort((a, b) => a.style.localeCompare(b.style) || parseInt(a.weight) - parseInt(b.weight))
    }
    await this.keep(fonts)
    await this.tidy(fonts)
    return fonts
  }

  async remove(id: string): Promise<ManuscriptFont[]> {
    const fonts = (await this.list()).filter(font => font.id !== id)
    await this.keep(fonts)
    await this.tidy(fonts)
    return fonts
  }

  // Files no family uses any more are deleted.
  private async tidy(fonts: ManuscriptFont[]) {
    const used = new Set(fonts.flatMap(font => font.faces.map(face => face.file)))
    for (const file of existsSync(this.folder) ? await readdir(this.folder) : []) if (FONT_FILE.test(file) && !used.has(file)) await rm(join(this.folder, file), { force: true })
  }

  async bytes(file: string): Promise<Uint8Array | null> {
    if (!FONT_FILE.test(file) || !existsSync(join(this.folder, file))) return null
    return new Uint8Array(await readFile(join(this.folder, file)))
  }

  // Every character of the project the family's faces cannot draw.
  async check(id: string, characters: string): Promise<{ family: string; missing: string[] } | null> {
    const font = (await this.list()).find(item => item.id === id)
    if (!font) return null
    const missing = new Set<string>()
    for (const face of font.faces) {
      const bytes = await this.bytes(face.file)
      if (bytes) for (const char of readFace(bytes, face.file, characters).missing) missing.add(char)
    }
    return { family: font.family, missing: [...missing] }
  }

  // The manuscript font as exports carry it: a font on this computer by name, a
  // font the writer added with its files, its license and its kind of letter.
  async exportFont(choice: string): Promise<ExportFont> {
    const font = choice.startsWith('user:') ? (await this.list()).find(item => item.id === choice.slice(5)) : undefined
    if (!font) return systemExportFont(choice)
    const faces: ExportFace[] = []
    let embeddable = true, generic: ExportFont['generic'] = 'serif'
    for (const face of font.faces) {
      const bytes = await this.bytes(face.file)
      if (!bytes) continue
      const format = face.file.split('.')[1] as FontFormat
      let truetype = false
      try {
        const read = create(bytes)
        if ('fonts' in read) throw Error('A collection is not a face.')
        // Usage permissions (OpenType OS/2 fsType): editable and installable fonts
        // may travel in documents; restricted and preview-only fonts may not.
        const permission = read['OS/2']?.fsType
        if (permission && !permission.editable && (permission.viewOnly || permission.noEmbedding)) embeddable = false
        truetype = (format === 'ttf' || format === 'otf') && Boolean(read.directory?.tables?.glyf)
        // PANOSE serif styles 11–15 are sans; a fixed pitch is monospace.
        const serifStyle = read['OS/2']?.panose?.[1] ?? 0
        if (read.post?.isFixedPitch) generic = 'monospace'
        else if (serifStyle >= 11 && serifStyle <= 15) generic = 'sans-serif'
      } catch { embeddable = false }
      faces.push({ file: face.file, format, weight: face.weight, italic: face.style === 'italic', bytes, truetype })
    }
    if (!faces.length) return systemExportFont('book')
    return { family: font.family, names: [font.family], stack: addedFontStack(font.family), generic, faces, embeddable }
  }
}
