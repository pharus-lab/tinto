import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { postHTML } from './exchange'
import { sectionRange } from './model'
import type { PostFields, PostImage, PostRecord } from './project-types'
import type { SiteImage, SiteTransport } from './site-api'
import type { ProjectStore } from './storage'

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGES = 20
export type ImageInput = { alt: string; file: string } | { alt: string; path: string; name: string }
export interface PublishInput { siteId: string; documentId: string; headingId: string | null; fields: PostFields; cover: ImageInput | null; images: ImageInput[] }

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

// One post per project, website, document and section. Deriving the id means
// a retry after any failure updates the same post instead of adding another.
export function postId(projectId: string, siteId: string, documentId: string, headingId: string | null): string {
  const hex = createHash('sha256').update([projectId, siteId, documentId, headingId ?? ''].join('\n')).digest('hex')
  const variant = (8 | (parseInt(hex[16], 16) & 3)).toString(16)
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16) + '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32)
}

// The website receives the file, type and description, never local file names.
const siteImage = ({ file, type, alt }: PostImage): SiteImage => ({ file, type, alt })

export class Publisher {
  private sites: (id: string) => Promise<SiteTransport>
  private now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(sites: (id: string) => Promise<SiteTransport>, now: () => number = Date.now) {
    this.sites = sites
    this.now = now
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  idle(): Promise<unknown> { return this.queue }

  // The local record changes only after the website has accepted the post.
  publish(store: ProjectStore, input: PublishInput): Promise<PostRecord> {
    return this.serial(async () => {
      const doc = store.readDocument(input.documentId)
      let blocks = doc.manuscript.content
      if (input.headingId) {
        // The section heading becomes the post title, so the body starts after it.
        const range = sectionRange(doc.manuscript, input.headingId)
        if (range.from === range.to) throw Error('This section is no longer in its document.')
        blocks = blocks.slice(range.from + 1, range.to)
      }
      const html = postHTML(blocks)
      if (!html) throw Error('Write some text before publishing this post.')
      const fields = validateFields(input.fields)
      if ((input.cover ? 1 : 0) + input.images.length > MAX_IMAGES) throw Error('A post can include up to ' + MAX_IMAGES + ' images.')
      const site = await this.sites(input.siteId)
      const previous = store.post(input.siteId, input.documentId, input.headingId)
      const id = previous?.id ?? postId(store.projectId(), input.siteId, input.documentId, input.headingId)
      const known = new Map((previous ? [previous.cover, ...previous.images] : []).filter(image => !!image).map(image => [image.file, image]))
      const uploads = new Map<string, { bytes: Uint8Array; type: string }>()
      async function prepare(choice: ImageInput): Promise<PostImage> {
        const alt = String(choice.alt ?? '').trim()
        if (alt.length > 300) throw Error('Keep image descriptions to 300 characters or fewer.')
        if ('file' in choice) {
          const existing = known.get(choice.file)
          if (!existing) throw Error('An image is no longer part of this post. Choose it again.')
          return { ...existing, alt }
        }
        const bytes = await readImage(choice.path, choice.name)
        const format = formats.find(item => item.test(bytes))
        if (!format) throw Error(choice.name + ' is not a PNG, JPEG, WebP, GIF or AVIF image.')
        // Files named by content make a repeated upload of the same image harmless.
        const file = createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '.' + format.ext
        if (!known.has(file)) uploads.set(file, { bytes, type: format.type })
        return { file, type: format.type, alt, name: choice.name }
      }
      const cover = input.cover ? await prepare(input.cover) : null
      const images: PostImage[] = []
      for (const choice of input.images) images.push(await prepare(choice))

      // Images first, so the website never receives a post whose images it lacks.
      for (const [file, upload] of uploads) await site.putImage(id, file, upload.bytes, upload.type)
      const time = this.now()
      const { url } = await site.putPost(id, {
        slug: fields.slug, language: doc.language, title: fields.title, summary: fields.summary, date: fields.date, tags: fields.tags,
        html, cover: cover ? siteImage(cover) : null, images: images.map(siteImage), updatedAt: new Date(time).toISOString()
      })
      const post: PostRecord = {
        id, siteId: input.siteId, documentId: input.documentId, headingId: input.headingId, ...fields,
        language: doc.language, cover, images, url, publishedAt: time
      }
      store.savePost(post)
      return post
    })
  }

  unpublish(store: ProjectStore, siteId: string, documentId: string, headingId: string | null): Promise<void> {
    return this.serial(async () => {
      const post = store.post(siteId, documentId, headingId)
      if (!post) return
      await (await this.sites(siteId)).deletePost(post.id)
      store.deletePost(post.id)
    })
  }
}
