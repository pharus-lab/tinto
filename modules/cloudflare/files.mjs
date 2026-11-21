// Tinto blog module for Cloudflare — the file types a post can carry.
// Tinto and the module both use this list, so they always agree on what is
// accepted. A file's own first bytes decide its type, never its name.

const MB = 1024 * 1024

/**
 * How each class of file is stored and served.
 * @type {Record<string, { max: number, inline: boolean, ranges: boolean }>}
 */
export const FILE_CLASSES = {
  images: { max: 15 * MB, inline: true, ranges: false },
  documents: { max: 25 * MB, inline: true, ranges: true },
  audio: { max: 50 * MB, inline: true, ranges: true },
  video: { max: 95 * MB, inline: true, ranges: true },
  downloads: { max: 25 * MB, inline: false, ranges: false }
}

const ascii = (/** @type {Uint8Array} */ bytes, /** @type {number} */ from, /** @type {number} */ to) => String.fromCharCode(...bytes.subarray(from, to))
const brand = (/** @type {Uint8Array} */ bytes) => ascii(bytes, 4, 8) === 'ftyp' ? ascii(bytes, 8, 12) : ''
const audioBrands = ['M4A ', 'M4B ']
const imageBrands = ['avif', 'avis']
// UTF-8 text without NUL bytes: the closest a CSV file comes to a signature.
function text(/** @type {Uint8Array} */ bytes) {
  if (bytes.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

/**
 * Every accepted extension, its media type, class and signature test. The test
 * receives the whole file, except for large audio and video, which are checked
 * by their first 64 bytes as they stream.
 * @type {Record<string, { type: string, class: string, test: (bytes: Uint8Array) => boolean }>}
 */
export const FILE_TYPES = {
  png: { type: 'image/png', class: 'images', test: b => ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n' },
  jpg: { type: 'image/jpeg', class: 'images', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { type: 'image/gif', class: 'images', test: b => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)) },
  webp: { type: 'image/webp', class: 'images', test: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  avif: { type: 'image/avif', class: 'images', test: b => imageBrands.includes(brand(b)) },
  pdf: { type: 'application/pdf', class: 'documents', test: b => ascii(b, 0, 5) === '%PDF-' },
  // Video before audio: an MP4 container without a name hint is a video.
  mp4: { type: 'video/mp4', class: 'video', test: b => !!brand(b) && !imageBrands.includes(brand(b)) && !audioBrands.includes(brand(b)) },
  webm: { type: 'video/webm', class: 'video', test: b => ascii(b, 0, 4) === '\x1a\x45\xdf\xa3' && ascii(b, 0, 64).includes('webm') },
  mp3: { type: 'audio/mpeg', class: 'audio', test: b => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b[1] !== 0xff) },
  m4a: { type: 'audio/mp4', class: 'audio', test: b => !!brand(b) && !imageBrands.includes(brand(b)) },
  ogg: { type: 'audio/ogg', class: 'audio', test: b => ascii(b, 0, 4) === 'OggS' },
  zip: { type: 'application/zip', class: 'downloads', test: b => ['PK\x03\x04', 'PK\x05\x06'].includes(ascii(b, 0, 4)) },
  csv: { type: 'text/csv', class: 'downloads', test: text }
}

// A stored file is named by the first 32 hex characters of its SHA-256.
export const FILE_NAME = new RegExp('^([0-9a-f]{32})\\.(' + Object.keys(FILE_TYPES).join('|') + ')$')

export const extensionOf = (/** @type {string} */ name) => {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()
  return ext === 'jpeg' ? 'jpg' : ext
}

/**
 * The extension a file really is, judged by its bytes. When several types
 * share a signature (MP4 video and M4A audio), the file's own extension
 * decides. Returns null for anything that is not an accepted type.
 * @param {Uint8Array} bytes @param {string} name
 */
export function detectFile(bytes, name) {
  const matches = Object.keys(FILE_TYPES).filter(ext => ext !== 'csv' && FILE_TYPES[ext].test(bytes))
  const own = extensionOf(name)
  if (matches.includes(own)) return own
  if (matches.length) return matches[0]
  return own === 'csv' && FILE_TYPES.csv.test(bytes) ? 'csv' : null
}

/** The first 32 hex characters of a SHA-256. @param {Uint8Array} bytes */
export async function contentName(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const describeTypes = (/** @type {string} */ fileClass) =>
  Object.keys(FILE_TYPES).filter(ext => FILE_TYPES[ext].class === fileClass).map(ext => ext.toUpperCase()).join(', ')
