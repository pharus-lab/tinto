// Tinto blog module for Cloudflare — code shared by the Worker and the build loader.
// It uses only Web APIs, so the same file runs in Workers and in Node.

export const PROTOCOL = 1
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGES = 20
/** @type {Record<string, string>} */
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }
export const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// An image is named by the first 32 hex characters of its SHA-256.
export const IMAGE_FILE = /^([0-9a-f]{32})\.(png|jpg|webp|gif|avif)$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/
const LOCALE = /^[A-Za-z0-9-]{1,20}$/
// Tinto sends escaped text inside these bare tags (u is the author's underline;
// mark came from earlier versions). Anything else is refused, so a page can
// render the body as HTML.
const POST_TAGS = /<\/?(?:p|h[1-6]|strong|em|u|mark)>/g

/**
 * @typedef {{ file: string, type: string, alt: string, url: string }} TintoImage
 * @typedef {{
 *   id: string, slug: string, language: string, locale: string, title: string, summary: string,
 *   date: string, tags: string[], html: string, cover: TintoImage | null, images: TintoImage[],
 *   updatedAt: string, url: string | null
 * }} TintoPost
 * @typedef {{
 *   name: string, site: string, basePath?: string,
 *   languages?: Record<string, string> | null,
 *   postPath?: ((post: TintoPost) => string) | null
 * }} TintoConfig
 * @typedef {{ name: string, site: string, basePath: string, languages: Record<string, string> | null, postPath: ((post: TintoPost) => string) | null }} TintoSettings
 */

/** An error whose message is meant for the writer in Tinto. */
export class Rejection extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Checks tinto.config.mjs once, when the module starts. @param {TintoConfig} config @returns {TintoSettings} */
export function settings(config) {
  const name = String(config?.name ?? '').trim()
  if (!name) throw Error('tinto.config.mjs: set name to the site name Tinto should show.')
  let site = null
  try { site = new URL(String(config.site)) } catch { /* Reported below. */ }
  if (!site || !/^https?:$/.test(site.protocol)) throw Error('tinto.config.mjs: set site to the public address, such as https://example.com.')
  const basePath = String(config.basePath ?? '/api/tinto').replace(/\/+$/, '')
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath)) throw Error('tinto.config.mjs: basePath must be a path such as /api/tinto.')
  const languages = config.languages ?? null
  if (languages !== null && (typeof languages !== 'object' || !Object.keys(languages).length
    || Object.entries(languages).some(([code, locale]) => !/^[a-z]{2,3}$/.test(code) || typeof locale !== 'string' || !LOCALE.test(locale)))) {
    throw Error('tinto.config.mjs: languages maps two- or three-letter codes to the site locale, such as { en: "en", es: "es" }.')
  }
  const postPath = typeof config.postPath === 'function' ? config.postPath : null
  return { name, site: site.origin, basePath, languages, postPath }
}

export const imageKey = (/** @type {string} */ id, /** @type {string} */ file) => 'tinto/' + id + '/' + file
export const mediaPath = (/** @type {TintoSettings} */ site, /** @type {string} */ id, /** @type {string} */ file) => site.basePath + '/media/' + id + '/' + file

/** @param {string} html */
export const safeHTML = html => typeof html === 'string' && html.trim() !== '' && !/[<>]/.test(html.replace(POST_TAGS, ''))

/** The image format named by the file's first bytes, or null. @param {Uint8Array} bytes */
export function sniffImage(bytes) {
  const ascii = (/** @type {number} */ from, /** @type {number} */ to) => String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif'
  return null
}

/** The first 32 hex characters of the SHA-256, as Tinto names images. @param {Uint8Array} bytes */
export async function contentName(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** @param {string} value */
function validDate(value) {
  const time = Date.parse(value + 'T00:00:00Z')
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
}

/**
 * The site locale for a Tinto language code, such as en-GB → en, or null when
 * the site does not publish that language.
 * @param {string} language @param {Record<string, string> | null} languages
 */
export function localeFor(language, languages) {
  const primary = language.toLowerCase().split('-')[0]
  if (!languages) return primary
  return Object.hasOwn(languages, primary) ? languages[primary] : null
}

/**
 * Checks a post as Tinto sends it and returns the stored fields.
 * @param {any} input @param {Record<string, string> | null} languages
 */
export function checkPost(input, languages) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Rejection(400, 'Send the post as a JSON object.')
  const text = (/** @type {string} */ field, /** @type {number} */ max, required = true) => {
    const value = input[field] ?? ''
    if (typeof value !== 'string') throw new Rejection(422, 'The post ' + field + ' must be text.')
    const trimmed = value.trim()
    if (required && !trimmed) throw new Rejection(422, 'The post needs a ' + field + '.')
    if (trimmed.length > max) throw new Rejection(422, 'The post ' + field + ' can have up to ' + max + ' characters.')
    return trimmed
  }
  const slug = text('slug', 100)
  if (!SLUG.test(slug)) throw new Rejection(422, 'The address must use lowercase letters, numbers and single hyphens.')
  const title = text('title', 200)
  const summary = text('summary', 500, false)
  const date = text('date', 10)
  if (!validDate(date)) throw new Rejection(422, 'The post date must be a real date written as YYYY-MM-DD.')
  const language = text('language', 35)
  if (!LANGUAGE.test(language)) throw new Rejection(422, 'The post language must be a code such as en or es-MX.')
  const locale = localeFor(language, languages)
  if (!locale) throw new Rejection(422, 'This site publishes posts in ' + Object.keys(languages ?? {}).join(', ') + ' only.')
  const tags = input.tags ?? []
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.trim().length > 40)) {
    throw new Rejection(422, 'Tags must be a list of up to 20 texts of 40 characters or fewer.')
  }
  const html = input.html
  if (typeof html !== 'string' || html.length > 1_000_000 || !safeHTML(html)) throw new Rejection(422, 'The post body contains markup this site does not accept.')
  const image = (/** @type {any} */ value, /** @type {string} */ label) => {
    const match = IMAGE_FILE.exec(typeof value?.file === 'string' ? value.file : '')
    if (!match || value.type !== IMAGE_TYPES[match[2]]) throw new Rejection(422, 'The ' + label + ' is not a valid image reference.')
    const alt = value.alt ?? ''
    if (typeof alt !== 'string' || alt.trim().length > 300) throw new Rejection(422, 'The ' + label + ' description must be text of up to 300 characters.')
    return { file: value.file, type: value.type, alt: alt.trim() }
  }
  const cover = input.cover == null ? null : image(input.cover, 'cover')
  const gallery = input.images ?? []
  if (!Array.isArray(gallery)) throw new Rejection(422, 'The post images must be a list.')
  const images = gallery.map((item, index) => image(item, 'image ' + (index + 1)))
  if ((cover ? 1 : 0) + images.length > MAX_IMAGES) throw new Rejection(422, 'A post can include up to ' + MAX_IMAGES + ' images.')
  const time = Date.parse(typeof input.updatedAt === 'string' ? input.updatedAt : '')
  if (Number.isNaN(time)) throw new Rejection(422, 'The post needs an updatedAt time.')
  return {
    slug, language, locale, title, summary, date, tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))],
    html, cover, images, updatedAt: new Date(time).toISOString()
  }
}

/**
 * A stored post as the site shows it, with image and page addresses.
 * @param {TintoSettings} site @param {any} post @returns {TintoPost}
 */
export function publicPost(site, post) {
  const image = (/** @type {any} */ item) => ({ file: item.file, type: item.type, alt: item.alt, url: mediaPath(site, post.id, item.file) })
  const shown = {
    id: post.id, slug: post.slug, language: post.language, locale: post.locale, title: post.title, summary: post.summary,
    date: post.date, tags: post.tags, html: post.html, cover: post.cover ? image(post.cover) : null,
    images: post.images.map(image), updatedAt: post.updatedAt, url: null
  }
  return { ...shown, url: site.postPath ? new URL(site.postPath(shown), site.site).href : null }
}

/**
 * Checks the posts of a feed again before a build renders them.
 * @param {TintoSettings} site @param {unknown[]} entries @returns {TintoPost[]}
 */
export function readFeed(site, entries) {
  const addresses = new Set()
  return entries.map(entry => {
    const item = /** @type {any} */ (entry)
    const id = typeof item?.id === 'string' ? item.id : ''
    try {
      if (!POST_ID.test(id)) throw new Rejection(422, 'invalid id')
      const post = checkPost(item, null)
      const locale = typeof item.locale === 'string' ? item.locale : ''
      const allowed = site.languages ? Object.values(site.languages) : [post.locale]
      if (!LOCALE.test(locale) || !allowed.includes(locale)) throw new Rejection(422, 'locale "' + locale + '" is not one of this site\'s locales')
      const address = locale + '/' + post.slug
      if (addresses.has(address)) throw new Rejection(422, 'another post already uses /' + address)
      addresses.add(address)
      return publicPost(site, { ...post, id, locale })
    } catch (error) {
      throw Error('Tinto post ' + (id || '(without id)') + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  })
}
