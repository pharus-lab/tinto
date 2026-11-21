import type { Manuscript } from './model'
import type { ManuscriptFont } from './project-types'

// Themes are papers and inks; their colors live in styles.css under [data-theme].
export const THEMES: [string, string][] = [
  ['tinto', 'Tinto'], ['sepia', 'Sepia'], ['newsprint', 'Newsprint'], ['fountain', 'Fountain pen'], ['contrast', 'High contrast']
]
// Typefaces most computers have. A font the writer adds is checked against the
// project's characters; these fall back per character to the system's fonts.
export const SYSTEM_FONTS: [string, string, string][] = [
  ['book', 'Book serif', 'var(--book-serif)'],
  ['georgia', 'Georgia', "Georgia, 'Times New Roman', serif"],
  ['palatino', 'Palatino', "Palatino, 'Palatino Linotype', 'Book Antiqua', serif"],
  ['charter', 'Charter', "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif"],
  ['sans', 'System sans', "system-ui, -apple-system, 'Segoe UI', sans-serif"],
  ['mono', 'Monospace', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace']
]
export const userFont = (id: string) => 'user:' + id
const familyName = (id: string) => 'Tinto font ' + id

export function fontStack(choice: string): string {
  if (choice.startsWith('user:') && /^[0-9a-f]{12}$/.test(choice.slice(5))) return '"' + familyName(choice.slice(5)) + '", var(--book-serif)'
  return SYSTEM_FONTS.find(([id]) => id === choice)?.[2] ?? 'var(--book-serif)'
}

const FORMATS: Record<string, string> = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }
// One @font-face per added file, served by Tinto from its own folder.
export function registerFontFaces(fonts: ManuscriptFont[]) {
  let style = document.getElementById('manuscript-fonts')
  if (!style) {
    style = document.createElement('style')
    style.id = 'manuscript-fonts'
    document.head.append(style)
  }
  style.textContent = fonts.flatMap(font => font.faces.filter(face => /^[0-9a-f]{32}\.(ttf|otf|woff|woff2)$/.test(face.file)).map(face =>
    '@font-face { font-family: "' + familyName(font.id) + '"; src: url("fonts/' + face.file + '") format("' + FORMATS[face.file.split('.')[1]] + '"); '
    + 'font-weight: ' + (/^\d{1,4}( \d{1,4})?$/.test(face.weight) ? face.weight : '400') + '; font-style: ' + (face.style === 'italic' ? 'italic' : 'normal') + '; font-display: block; }'
  )).join('\n')
}

// How a missing character is named: itself, or its code point when it has no visible shape.
export const describeCharacter = (char: string) => /[\p{M}\p{C}\p{Z}]/u.test(char) ? 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') : char
export function listCharacters(chars: string[], limit = 12): string {
  const shown = chars.slice(0, limit).map(describeCharacter).join(' ')
  return chars.length > limit ? shown + ' and ' + (chars.length - limit) + ' more' : shown
}

// Every character the manuscripts use, including wordings not currently chosen.
export function manuscriptCharacters(manuscripts: Manuscript[]): string {
  const found = new Set<string>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const item = node as { type?: string; text?: string; content?: unknown[]; attrs?: { options?: { content?: unknown[] }[] } }
    if (item.type === 'text' && typeof item.text === 'string') for (const char of item.text) found.add(char)
    item.content?.forEach(visit)
    item.attrs?.options?.forEach(option => option.content?.forEach(visit))
  }
  manuscripts.forEach(visit)
  return [...found].join('')
}
