// Tinto blog module for Cloudflare — code shared by the Worker and the build loader.
// It uses only Web APIs, so the same file runs in Workers and in Node.
import { authorshipLabel, publicKeyFromDid } from './credential.mjs'
import { FILE_NAME, FILE_TYPES } from './files.mjs'

export const PROTOCOL = 2
export const MAX_FILES = 30
export const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/
const LOCALE = /^[A-Za-z0-9-]{1,20}$/
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Tinto sends escaped text inside these bare tags. u is the author's underline;
// mark came from earlier versions. Anything else is refused, so a page can
// render the body as HTML.
const POST_TAGS = /<\/?(?:p|h[1-6]|strong|em|u|mark)>/g

/**
 * @typedef {import('./credential.mjs').Authorship & { credential: string }} TintoAuthorship
 * @typedef {{ file: string, type: string, alt: string, url: string }} TintoImage
 * @typedef {{ file: string, type: string, title: string, size: number, url: string }} TintoAttachment
 * @typedef {{
 *   id: string, slug: string, language: string, locale: string, category: string, title: string, summary: string,
 *   date: string, tags: string[], html: string, cover: TintoImage | null, images: TintoImage[],
 *   attachments: TintoAttachment[], updatedAt: string, url: string | null, authorship: TintoAuthorship | null
 * }} TintoPost
 * @typedef {{
 *   name: string, site: string, basePath?: string,
 *   languages?: Record<string, string> | null,
 *   categories?: Record<string, string> | null,
 *   postPath?: ((post: TintoPost) => string) | null,
 *   previewPath?: string,
 *   author?: string | null
 * }} TintoConfig
 * @typedef {{
 *   name: string, site: string, basePath: string, languages: Record<string, string> | null,
 *   categories: Record<string, string> | null, postPath: ((post: TintoPost) => string) | null, previewPath: string,
 *   author: string | null
 * }} TintoSettings
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
  const categories = config.categories ?? null
  if (categories !== null && (typeof categories !== 'object' || !Object.keys(categories).length
    || Object.entries(categories).some(([id, label]) => !CATEGORY.test(id) || id.length > 40 || typeof label !== 'string' || !label.trim() || label.length > 60))) {
    throw Error('tinto.config.mjs: categories maps ids such as "notes" to labels such as "Notes".')
  }
  const postPath = typeof config.postPath === 'function' ? config.postPath : null
  const previewPath = String(config.previewPath ?? '/tinto-preview').replace(/\/+$/, '')
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(previewPath) || previewPath === basePath) {
    throw Error('tinto.config.mjs: previewPath must be a path such as /tinto-preview, outside basePath.')
  }
  const author = config.author ?? null
  if (author !== null) {
    try { publicKeyFromDid(String(author)) } catch { throw Error('tinto.config.mjs: author must be null or the did:key shown in Tinto under Settings → Author.') }
  }
  return { name, site: site.origin, basePath, languages, categories, postPath, previewPath, author }
}

/** Files are grouped by class: tinto/<post>/<class>/<file>. @param {string} id @param {string} file */
export function fileKey(id, file) {
  const ext = file.slice(file.lastIndexOf('.') + 1)
  return 'tinto/' + id + '/' + (FILE_TYPES[ext]?.class ?? 'other') + '/' + file
}
export const filePath = (/** @type {TintoSettings} */ site, /** @type {string} */ id, /** @type {string} */ file) => site.basePath + '/files/' + id + '/' + file

/** @param {string} html */
export const safeHTML = html => typeof html === 'string' && html.trim() !== '' && !/[<>]/.test(html.replace(POST_TAGS, ''))

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
 * @param {any} input @param {Pick<TintoSettings, 'languages' | 'categories'>} site
 */
export function checkPost(input, site) {
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
  const locale = localeFor(language, site.languages)
  if (!locale) throw new Rejection(422, 'This site publishes posts in ' + Object.keys(site.languages ?? {}).join(', ') + ' only.')
  const category = text('category', 40, false)
  if (site.categories ? !Object.hasOwn(site.categories, category) : category) {
    throw new Rejection(422, site.categories ? 'Choose one of this site’s categories: ' + Object.values(site.categories).join(', ') + '.' : 'This site has no categories.')
  }
  const status = input.status ?? 'published'
  if (status !== 'published' && status !== 'draft') throw new Rejection(422, 'The post status must be draft or published.')
  const tags = input.tags ?? []
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.trim().length > 40)) {
    throw new Rejection(422, 'Tags must be a list of up to 20 texts of 40 characters or fewer.')
  }
  const html = input.html
  if (typeof html !== 'string' || html.length > 1_000_000 || !safeHTML(html)) throw new Rejection(422, 'The post body contains markup this site does not accept.')
  const reference = (/** @type {any} */ value, /** @type {string} */ label, /** @type {boolean} */ image) => {
    const match = FILE_NAME.exec(typeof value?.file === 'string' ? value.file : '')
    const kind = match ? FILE_TYPES[match[2]] : null
    if (!kind || value.type !== kind.type || (kind.class === 'images') !== image) throw new Rejection(422, 'The ' + label + ' is not a valid file reference.')
    return /** @type {{ file: string, type: string }} */ ({ file: value.file, type: value.type })
  }
  const image = (/** @type {any} */ value, /** @type {string} */ label) => {
    const alt = value?.alt ?? ''
    if (typeof alt !== 'string' || alt.trim().length > 300) throw new Rejection(422, 'The ' + label + ' description must be text of up to 300 characters.')
    return { ...reference(value, label, true), alt: alt.trim() }
  }
  const attachment = (/** @type {any} */ value, /** @type {string} */ label) => {
    const title = typeof value?.title === 'string' ? value.title.trim() : ''
    if (!title || title.length > 120) throw new Rejection(422, 'The ' + label + ' needs a title of up to 120 characters.')
    const size = Number(value.size ?? 0)
    if (!Number.isSafeInteger(size) || size < 0) throw new Rejection(422, 'The ' + label + ' size is not valid.')
    return { ...reference(value, label, false), title, size }
  }
  const list = (/** @type {string} */ field) => {
    const value = input[field] ?? []
    if (!Array.isArray(value)) throw new Rejection(422, 'The post ' + field + ' must be a list.')
    return value
  }
  const cover = input.cover == null ? null : image(input.cover, 'cover')
  const images = list('images').map((item, index) => image(item, 'image ' + (index + 1)))
  const attachments = list('attachments').map((item, index) => attachment(item, 'attachment ' + (index + 1)))
  if ((cover ? 1 : 0) + images.length + attachments.length > MAX_FILES) throw new Rejection(422, 'A post can include up to ' + MAX_FILES + ' files.')
  const time = Date.parse(typeof input.updatedAt === 'string' ? input.updatedAt : '')
  if (Number.isNaN(time)) throw new Rejection(422, 'The post needs an updatedAt time.')
  // The authorship credential is checked by the Worker, which can verify signatures.
  const credential = input.credential ?? null
  if (credential !== null && (typeof credential !== 'object' || Array.isArray(credential) || JSON.stringify(credential).length > 200_000)) {
    throw new Rejection(422, 'The authorship credential is not valid.')
  }
  return {
    slug, language, locale, category, status, title, summary, date, tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))],
    html, cover, images, attachments, updatedAt: new Date(time).toISOString(), credential
  }
}

/** Every file a post refers to. @param {{ cover: { file: string } | null, images: { file: string }[], attachments: { file: string }[] }} post */
export const postFiles = post => [...(post.cover ? [post.cover] : []), ...post.images, ...post.attachments].map(item => item.file)

/**
 * A stored post as the site shows it, with file and page addresses.
 * @param {TintoSettings} site @param {any} post @returns {TintoPost}
 */
export function publicPost(site, post) {
  const url = (/** @type {string} */ file) => filePath(site, post.id, file)
  const image = (/** @type {any} */ item) => ({ file: item.file, type: item.type, alt: item.alt, url: url(item.file) })
  const shown = {
    id: post.id, slug: post.slug, language: post.language, locale: post.locale, category: post.category ?? '', title: post.title,
    summary: post.summary, date: post.date, tags: post.tags, html: post.html, cover: post.cover ? image(post.cover) : null,
    images: post.images.map(image),
    attachments: (post.attachments ?? []).map((/** @type {any} */ item) => ({ file: item.file, type: item.type, title: item.title, size: item.size, url: url(item.file) })),
    updatedAt: post.updatedAt, url: null, authorship: readAuthorship(site, post.id, post.authorship)
  }
  return { ...shown, url: site.postPath ? new URL(site.postPath(shown), site.site).href : null }
}

const IRI = /^https?:\/\/[\x21-\x7e]{1,200}$/
/**
 * The authorship the Worker verified when the post arrived, kept to known
 * fields so a page can rely on their types. Its credential is public at
 * <basePath>/credentials/<id>, for anyone to verify again.
 * @param {TintoSettings} site @param {string} id @param {any} value @returns {TintoAuthorship | null}
 */
export function readAuthorship(site, id, value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  if (!value || value.verified !== true || typeof value.author?.id !== 'string' || !value.author.id.startsWith('did:key:')) return null
  const type = (/** @type {unknown} */ iri) => typeof iri === 'string' && IRI.test(iri) ? iri : null
  const origins = ['written', 'pasted', 'imported', 'ai', 'mixed']
  return {
    verified: true,
    author: { id: value.author.id.slice(0, 100), name: typeof value.author.name === 'string' ? value.author.name.slice(0, 100) : '' },
    original: value.original === true, ai: value.ai === true, digitalSourceType: type(value.digitalSourceType),
    parts: (Array.isArray(value.parts) ? value.parts : []).slice(0, 5000).map((/** @type {any} */ part, /** @type {number} */ index) => ({
      position: index + 1, origin: origins.includes(part?.origin) ? part.origin : 'mixed', digitalSourceType: type(part?.digitalSourceType)
    })),
    signed: typeof value.signed === 'string' ? value.signed.slice(0, 40) : '',
    credential: site.basePath + '/credentials/' + id
  }
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
      const post = checkPost(item, { languages: null, categories: site.categories })
      const locale = typeof item.locale === 'string' ? item.locale : ''
      const allowed = site.languages ? Object.values(site.languages) : [post.locale]
      if (!LOCALE.test(locale) || !allowed.includes(locale)) throw new Rejection(422, 'locale "' + locale + '" is not one of this site\'s locales')
      const address = locale + '/' + post.category + '/' + post.slug
      if (addresses.has(address)) throw new Rejection(422, 'another post already uses ' + address)
      addresses.add(address)
      return publicPost(site, { ...post, id, locale, authorship: item.authorship })
    } catch (error) {
      throw Error('Tinto post ' + (id || '(without id)') + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  })
}

const ESCAPES = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })
const escapeHTML = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char])
const sizeText = (/** @type {number} */ bytes) => bytes < 1_048_576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1_048_576).toFixed(1) + ' MB'
const EACH = /<template\s+data-tinto-each="(cover|images|tags|attachments)"\s*>([\s\S]*?)<\/template>/g

/**
 * Fills the site's preview page with a post. The page marks fields with
 * %%title%%, %%summary%%, %%date%%, %%category%%, %%language%%, %%authorship%%
 * (a quiet line such as "Original · written by Ana") and %%body%%, and
 * repeats <template data-tinto-each="cover|images|tags|attachments"> once per
 * item, with %%url%%, %%alt%%, %%title%%, %%type%%, %%size%% and %%tag%%.
 * Everything is filled in one pass, so the author's text is never read as a marker.
 * @param {string} template @param {TintoPost} post @param {TintoSettings} site
 */
export function renderPreview(template, post, site) {
  const fields = {
    title: post.title, summary: post.summary, date: post.date, language: post.language,
    category: post.category ? site.categories?.[post.category] ?? post.category : '', authorship: authorshipLabel(post.authorship)
  }
  const lists = {
    cover: post.cover ? [{ url: post.cover.url, alt: post.cover.alt }] : [],
    images: post.images.map(image => ({ url: image.url, alt: image.alt })),
    tags: post.tags.map(tag => ({ tag })),
    attachments: post.attachments.map(item => ({ url: item.url, title: item.title, type: item.type, size: sizeText(item.size) }))
  }
  /** @param {string} text @param {Record<string, unknown>} values @param {boolean} body */
  const fill = (text, values, body) => text.replace(/%%([a-z]+)%%/g, (whole, name) => {
    if (name === 'body' && body) return post.html
    return Object.hasOwn(values, name) ? escapeHTML(values[name]) : whole
  })
  let out = ''
  let last = 0
  for (const match of template.matchAll(EACH)) {
    out += fill(template.slice(last, match.index), fields, true)
    out += lists[/** @type {keyof typeof lists} */ (match[1])].map(item => fill(match[2], { ...fields, ...item }, false)).join('')
    last = (match.index ?? 0) + match[0].length
  }
  return out + fill(template.slice(last), fields, true)
}
