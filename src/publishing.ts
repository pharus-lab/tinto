import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { FILE_CLASSES, FILE_TYPES, describeTypes, detectFile } from '../modules/cloudflare/files.mjs'
import type { AuthorSigner } from './author'
import { authorshipCredential } from './authorship'
import { postHTML } from './exchange'
import { sectionRange, type BlockJSON } from './model'
import type { DocumentRecord, PostAttachment, PostFields, PostImage, PostRecord, PostRelease, PostStatus } from './project-types'
import type { SitePost, SiteTransport } from './site-api'
import type { ProjectStore } from './storage'

export const MAX_FILES = 30
const LARGEST = Math.max(...Object.values(FILE_CLASSES).map(fileClass => fileClass.max))
export type ImageInput = { alt: string; file: string } | { alt: string; path: string; name: string }
export type AttachmentInput = { title: string; file: string } | { title: string; path: string; name: string }
export interface PublishInput {
  siteId: string
  siteName: string
  documentId: string
  headingId: string | null
  status: PostStatus
  fields: PostFields
  cover: ImageInput | null
  images: ImageInput[]
  attachments: AttachmentInput[]
}
export type Progress = (done: number, total: number) => void

const megabytes = (bytes: number) => Math.round(bytes / 1_048_576) + ' MB'
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

// The file's own first bytes decide its type; a renamed file cannot pass as another kind.
async function readFile(path: string, name: string) {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > LARGEST) throw Error(name + ' is larger than ' + megabytes(LARGEST) + '.')
    const bytes = new Uint8Array(await file.readFile())
    const ext = detectFile(bytes, name)
    if (!ext) throw Error(name + ' is not a file type a post can include.')
    const kind = FILE_TYPES[ext]
    const limit = FILE_CLASSES[kind.class].max
    if (bytes.byteLength > limit) throw Error(name + ' is larger than ' + megabytes(limit) + ', the limit for ' + kind.class + '.')
    return { bytes, ext, type: kind.type, fileClass: kind.class }
  } finally { await file.close() }
}

// A linked section is posted without its own heading, which becomes the title.
export function bodyBlocks(doc: DocumentRecord, headingId: string | null): BlockJSON[] {
  if (!headingId) return doc.manuscript.content
  const range = sectionRange(doc.manuscript, headingId)
  if (range.from === range.to) throw Error('This section is no longer in its document.')
  return doc.manuscript.content.slice(range.from + 1, range.to)
}
export const bodyHTML = (doc: DocumentRecord, headingId: string | null) => postHTML(bodyBlocks(doc, headingId))
export const bodyHash = (html: string) => sha256(html)

export function validateFields(input: PostFields): PostFields {
  const text = (value: unknown) => String(value ?? '').trim()
  const title = text(input?.title)
  const slug = text(input?.slug)
  const summary = text(input?.summary)
  const date = text(input?.date)
  const category = text(input?.category)
  const tags = [...new Set((Array.isArray(input?.tags) ? input.tags : []).map(text).filter(Boolean))]
  if (!title || title.length > 200) throw Error('Give the post a title of up to 200 characters.')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) throw Error('Use lowercase letters, numbers and single hyphens for the address, such as first-light.')
  if (summary.length > 500) throw Error('Keep the summary to 500 characters or fewer.')
  const time = Date.parse(date + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) throw Error('Choose a valid post date.')
  if (tags.length > 20 || tags.some(tag => tag.length > 40)) throw Error('Use up to 20 tags of 40 characters or fewer.')
  if (category && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) throw Error('Choose one of the website’s categories.')
  return { title, slug, summary, date, tags, category }
}

// One post per project, website, document and section. Deriving the id means
// a retry after any failure updates the same post instead of adding another.
export function postId(projectId: string, siteId: string, documentId: string, headingId: string | null): string {
  const hex = sha256([projectId, siteId, documentId, headingId ?? ''].join('\n'))
  const variant = (8 | (parseInt(hex[16], 16) & 3)).toString(16)
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16) + '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32)
}

// A few uploads at a time: faster than one by one, without flooding the connection.
async function inParallel<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++])
  }))
}

export const NO_AUTHOR = 'Add your name as the author first. Tinto signs every post, so the website can show who wrote it.'

// A translation points to its original: the original's post on this website
// when there is one, else the original document's title and language.
function translationOf(store: ProjectStore, doc: DocumentRecord, siteId: string) {
  if (!doc.translation) return undefined
  const translator = (doc.translation.provider ?? 'OpenAI') + ' ' + doc.translation.model
  let original: DocumentRecord | null = null
  try { original = store.readDocument(doc.translation.of) } catch { /* The original was deleted; the translation keeps its own record. */ }
  const post = original ? store.post(siteId, original.id, null) : null
  return { language: doc.translation.from, title: post?.title ?? original?.title ?? '', url: post?.url ?? null, translator }
}

export class Publisher {
  private sites: (id: string) => Promise<SiteTransport>
  private author: () => Promise<AuthorSigner | null>
  private now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(sites: (id: string) => Promise<SiteTransport>, author: () => Promise<AuthorSigner | null>, now: () => number = Date.now) {
    this.sites = sites
    this.author = author
    this.now = now
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  idle(): Promise<unknown> { return this.queue }

    // Checks the post, reads its new files and uploads them, three at a time.
  // Publishing and previewing share this, so a preview shows exactly what would go out.
  private async prepare(store: ProjectStore, input: PublishInput, progress: Progress) {
    const doc = store.readDocument(input.documentId)
    const blocks = bodyBlocks(doc, input.headingId)
    const html = postHTML(blocks)
    if (!html) throw Error('Write some text before publishing this post.')
    const fields = validateFields(input.fields)
    if ((input.cover ? 1 : 0) + input.images.length + input.attachments.length > MAX_FILES) throw Error('A post can include up to ' + MAX_FILES + ' files.')
    const author = await this.author()
    if (!author) throw Error(NO_AUTHOR)
    const site = await this.sites(input.siteId)
    const previous = store.post(input.siteId, input.documentId, input.headingId)
    const id = previous?.id ?? postId(store.projectId(), input.siteId, input.documentId, input.headingId)
    const known = new Map<string, PostImage | PostAttachment>((previous ? [previous.cover, ...previous.images, ...previous.attachments] : [])
      .filter(item => !!item).map(item => [item!.file, item!]))
    const uploads = new Map<string, { bytes: Uint8Array; type: string }>()
    async function load(choice: { path: string; name: string }, images: boolean) {
      const read = await readFile(choice.path, choice.name)
      if ((read.fileClass === 'images') !== images) {
        throw Error(choice.name + (images ? ' is not an image. Use ' + describeTypes('images') + '.' : ' is an image. Add it to the gallery instead.'))
      }
      // Files named by content make a repeated upload of the same file harmless.
      const file = sha256(read.bytes).slice(0, 32) + '.' + read.ext
      if (!known.has(file)) uploads.set(file, { bytes: read.bytes, type: read.type })
      return { file, type: read.type, size: read.bytes.byteLength, name: choice.name }
    }
    function reuse(file: string) {
      const existing = known.get(file)
      if (!existing) throw Error('A file is no longer part of this post. Choose it again.')
      return existing
    }
    async function image(choice: ImageInput): Promise<PostImage> {
      const alt = String(choice.alt ?? '').trim()
      if (alt.length > 300) throw Error('Keep image descriptions to 300 characters or fewer.')
      if ('file' in choice) return { ...(reuse(choice.file) as PostImage), alt }
      const { file, type, name } = await load(choice, true)
      return { file, type, alt, name }
    }
    async function attachment(choice: AttachmentInput): Promise<PostAttachment> {
      const title = String(choice.title ?? '').trim()
      if (!title || title.length > 120) throw Error('Give each attachment a title of up to 120 characters.')
      if ('file' in choice) return { ...(reuse(choice.file) as PostAttachment), title }
      return { ...await load(choice, false), title }
    }
    const cover = input.cover ? await image(input.cover) : null
    const images: PostImage[] = []
    for (const choice of input.images) images.push(await image(choice))
    const attachments: PostAttachment[] = []
    for (const choice of input.attachments) attachments.push(await attachment(choice))

    // Files first, so the website never receives a post whose files it lacks.
    const pending = [...uploads]
    let done = 0
    if (pending.length) progress(0, pending.length)
    await inParallel(pending, 3, async ([file, upload]) => {
      await site.putFile(id, file, upload.bytes, upload.type)
      progress(++done, pending.length)
    })
    const time = this.now()
    const signed = await authorshipCredential(author, {
      postId: id, title: fields.title, language: doc.language, blocks, html, time,
      files: [...(cover ? [cover] : []), ...images, ...attachments].map(({ file, type }) => ({ file, type })),
      evidence: store.writingEvidence(input.documentId), previous: previous?.credential ?? null,
      translation: translationOf(store, doc, input.siteId)
    })
    const sent: SitePost = {
      slug: fields.slug, language: doc.language, category: fields.category, status: input.status, title: fields.title,
      summary: fields.summary, date: fields.date, tags: fields.tags, html,
      cover: cover ? { file: cover.file, type: cover.type, alt: cover.alt } : null,
      images: images.map(({ file, type, alt }) => ({ file, type, alt })),
      attachments: attachments.map(({ file, type, title, size }) => ({ file, type, title, size })),
      updatedAt: new Date(time).toISOString(), credential: signed.credential
    }
    return { site, doc, html, fields, previous, id, cover, images, attachments, sent, time, credential: { id: signed.id, sha256: signed.sha256 } }
  }

  // The local record changes only after the website has accepted the post. A
  // publication whose text changed is kept in History as a named version.
  publish(store: ProjectStore, input: PublishInput, progress: Progress = () => {}): Promise<PostRecord> {
    return this.serial(async () => {
      const { site, doc, html, fields, previous, id, cover, images, attachments, sent, time, credential } = await this.prepare(store, input, progress)
      const { url, verified } = await site.putPost(id, sent)
      let release: PostRelease | null = previous?.release ?? null
      const body = bodyHash(html)
      if (input.status === 'published') {
        release = release?.body === body
          ? { ...release, at: time }
          : { at: time, body, versionId: store.snapshot(input.documentId, 'Released on ' + input.siteName) }
        store.recordRelease(input.documentId, { site: input.siteId, post: id, body, credential: credential.sha256 })
      }
      const post: PostRecord = {
        id, siteId: input.siteId, documentId: input.documentId, headingId: input.headingId, ...fields,
        language: doc.language, status: input.status, cover, images, attachments, url, publishedAt: time, release, credential, verified: verified === true
      }
      store.savePost(post)
      return post
    })
  }

  // A preview goes to the website beside the live post and leaves the local record alone.
  preview(store: ProjectStore, input: PublishInput, progress: Progress = () => {}): Promise<string> {
    return this.serial(async () => {
      const { site, id, sent } = await this.prepare(store, input, progress)
      return (await site.putPreview(id, sent)).url
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

// Whether the text has changed since the website last received it as published.
export function changedSinceRelease(store: ProjectStore, post: PostRecord): boolean {
  if (post.status !== 'published' || !post.release) return false
  try { return bodyHash(bodyHTML(store.readDocument(post.documentId), post.headingId)) !== post.release.body }
  catch { return true }
}
