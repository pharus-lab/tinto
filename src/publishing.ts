import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { DELETE_POST, UPSERT_POST, type SiteTransport } from './cloudflare'
import { postHTML } from './exchange'
import { sectionRange } from './model'
import type { PostFields, PostImage, PostRecord, PublishResult } from './project-types'
import type { ProjectStore } from './storage'

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGES = 20
export type ImageInput = { alt: string; key: string } | { alt: string; path: string; name: string }
export interface PublishInput { documentId: string; headingId: string | null; fields: PostFields; cover: ImageInput | null; images: ImageInput[] }

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
// The file's own signature decides its type; a renamed file cannot pass as an image.
const formats = [
  { type: 'image/png', ext: 'png', test: (b: Uint8Array) => ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n' },
  { type: 'image/jpeg', ext: 'jpg', test: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b: Uint8Array) => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)) },
  { type: 'image/webp', ext: 'webp', test: (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { type: 'image/avif', ext: 'avif', test: (b: Uint8Array) => ascii(b, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 12)) }
]

async function readImage(path: string, name: string): Promise<Uint8Array> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_IMAGE_BYTES) throw Error(name + ' is larger than 15 MB. Choose a smaller image.')
    return new Uint8Array(await file.readFile())
  } finally { await file.close() }
}

export function validateFields(input: PostFields): PostFields {
  const text = (value: unknown) => String(value ?? '').trim()
  const title = text(input?.title)
  const slug = text(input?.slug)
  const summary = text(input?.summary)
  const date = text(input?.date)
  const tags = [...new Set((Array.isArray(input?.tags) ? input.tags : []).map(text).filter(Boolean))]
  if (!title || title.length > 200) throw Error('Give the post a title of up to 200 characters.')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) throw Error('Use lowercase letters, numbers and single hyphens for the address, such as first-light.')
  if (summary.length > 500) throw Error('Keep the summary to 500 characters or fewer.')
  const time = Date.parse(date + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) throw Error('Choose a valid post date.')
  if (tags.length > 20 || tags.some(tag => tag.length > 40)) throw Error('Use up to 20 tags of 40 characters or fewer.')
  return { title, slug, summary, date, tags }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const keysOf = (post: PostRecord) => [...(post.cover ? [post.cover.key] : []), ...post.images.map(image => image.key)]
// The website receives the object key, type and description, never local file names.
const publicImage = ({ key, type, alt }: PostImage) => ({ key, type, alt })

export class Publisher {
  private site: () => Promise<SiteTransport>
  private now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(site: () => Promise<SiteTransport>, now: () => number = Date.now) {
    this.site = site
    this.now = now
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  idle(): Promise<unknown> { return this.queue }

  publish(store: ProjectStore, input: PublishInput): Promise<PublishResult> {
    return this.serial(async () => {
      const doc = store.readDocument(input.documentId)
      let blocks = doc.manuscript.content
      if (input.headingId) {
        // The section heading becomes the post title, so the body starts after it.
        const range = sectionRange(doc.manuscript, input.headingId)
        if (range.from === range.to) throw Error('This section is no longer in its document.')
        blocks = blocks.slice(range.from + 1, range.to)
      }
      const body = postHTML(blocks)
      if (!body) throw Error('Write some text before publishing this post.')
      const fields = validateFields(input.fields)
      if ((input.cover ? 1 : 0) + input.images.length > MAX_IMAGES) throw Error('A post can include up to ' + MAX_IMAGES + ' images.')
      const site = await this.site()
      const previous = store.post(input.documentId, input.headingId)
      const id = previous?.id ?? randomUUID()
      const known = new Map((previous ? [previous.cover, ...previous.images] : []).filter(image => !!image).map(image => [image.key, image]))
      const uploads = new Map<string, { bytes: Uint8Array; type: string }>()
      async function prepare(choice: ImageInput): Promise<PostImage> {
        const alt = String(choice.alt ?? '').trim()
        if (alt.length > 300) throw Error('Keep image descriptions to 300 characters or fewer.')
        if ('key' in choice) {
          const existing = known.get(choice.key)
          if (!existing) throw Error('An image is no longer part of this post. Choose it again.')
          return { ...existing, alt }
        }
        const bytes = await readImage(choice.path, choice.name)
        const format = formats.find(item => item.test(bytes))
        if (!format) throw Error(choice.name + ' is not a PNG, JPEG, WebP, GIF or AVIF image.')
        // Content-addressed keys make a repeated upload of the same image harmless.
        const key = 'posts/' + id + '/' + createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.' + format.ext
        if (!known.has(key)) uploads.set(key, { bytes, type: format.type })
        return { key, type: format.type, alt, name: choice.name }
      }
      const cover = input.cover ? await prepare(input.cover) : null
      const images: PostImage[] = []
      for (const choice of input.images) images.push(await prepare(choice))

      // Images first: D1 must never reference an object that is not in R2.
      for (const [key, upload] of uploads) await site.putObject(key, upload.bytes, upload.type)
      const time = this.now()
      await site.query(UPSERT_POST, [
        id, fields.slug, doc.language, fields.title, fields.summary, fields.date, JSON.stringify(fields.tags), body,
        cover ? JSON.stringify(publicImage(cover)) : '', JSON.stringify(images.map(publicImage)), new Date(time).toISOString()
      ])
      const current = new Set([...(cover ? [cover.key] : []), ...images.map(image => image.key)])
      const obsolete = [...new Set([...(previous?.obsolete ?? []), ...known.keys()])].filter(key => !current.has(key))
      const post: PostRecord = {
        id, documentId: input.documentId, headingId: input.headingId, ...fields, locale: doc.language,
        cover, images, obsolete, publishedAt: time, deployPending: true, removed: false
      }
      store.savePost(post)
      return this.deploy(store, post, site)
    })
  }

  unpublish(store: ProjectStore, documentId: string, headingId: string | null): Promise<PublishResult> {
    return this.serial(async () => {
      const post = store.post(documentId, headingId)
      if (!post) return { post: null, deployError: null }
      const site = await this.site()
      await site.query(DELETE_POST, [post.id])
      const removed = { ...post, removed: true, deployPending: true }
      store.savePost(removed)
      return this.deploy(store, removed, site)
    })
  }

  rebuild(store: ProjectStore, documentId: string, headingId: string | null): Promise<PublishResult> {
    return this.serial(async () => {
      const site = await this.site()
      const post = store.post(documentId, headingId)
      if (post) return this.deploy(store, post, site)
      try { await site.triggerDeploy(); return { post: null, deployError: null } }
      catch (error) { return { post: null, deployError: message(error) } }
    })
  }

  // D1 already holds the post. A failed hook leaves it marked for a retry,
  // and objects the rebuilt site no longer uses are removed only afterwards.
  private async deploy(store: ProjectStore, post: PostRecord, site: SiteTransport): Promise<PublishResult> {
    try { await site.triggerDeploy() }
    catch (error) { return { post, deployError: message(error) } }
    const kept: string[] = []
    for (const key of post.removed ? [...keysOf(post), ...post.obsolete] : post.obsolete) {
      try { await site.deleteObject(key) } catch { kept.push(key) }
    }
    if (post.removed) {
      store.deletePost(post.id)
      return { post: null, deployError: null }
    }
    const done = { ...post, obsolete: kept, deployPending: false }
    store.savePost(done)
    return { post: done, deployError: null }
  }
}
