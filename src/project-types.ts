import type { BlockJSON, Manuscript } from './model'

export interface DocumentRecord {
  id: string
  title: string
  language: string
  manuscript: Manuscript
  source?: { documentId: string; headingId: string | null }
}

export interface DraftChange {
  id: string
  revision: string
  origin: 'draft' | 'original' | 'conflict'
  kind: 'added' | 'deleted' | 'modified'
  baseline: BlockJSON | null
  original: BlockJSON | null
  draft: BlockJSON | null
}

export interface DraftResolution {
  id: string
  revision: string
  choice: 'original' | 'draft' | 'edited'
  block?: BlockJSON | null
}

export interface Project {
  id: string
  title: string
  documents: DocumentRecord[]
}

export interface Version {
  id: string
  name: string | null
  time: number
  manuscript: Manuscript
  language: string
}

export interface RecentProject { path: string; title: string }
export interface Workspace { project: Project; path: string; recent: RecentProject[] }

export interface LibraryState {
  folder: string | null
  folders: string[]
  projects: RecentProject[]
  workspace: Workspace | null
}

// A document or linked section posted on one website. Files are named by their
// content; `name` is the local file name and stays in Tinto.
export interface PostImage { file: string; type: string; alt: string; name: string }
// Attachments are documents, audio, video and downloads. Their title is what
// the website shows, so it is chosen by the writer.
export interface PostAttachment { file: string; type: string; title: string; size: number; name: string }
export interface PostFields { title: string; slug: string; summary: string; date: string; tags: string[]; category: string }
export type PostStatus = 'draft' | 'published'
// The text last published: a named version in History and a hash of its body.
export interface PostRelease { at: number; versionId: string; body: string }
// The authorship credential sent last, so the next one can point back to it.
export interface PostCredential { id: string; sha256: string }
export interface PostRecord extends PostFields {
  id: string
  siteId: string
  documentId: string
  headingId: string | null
  language: string
  status: PostStatus
  cover: PostImage | null
  images: PostImage[]
  attachments: PostAttachment[]
  url: string | null
  publishedAt: number
  release: PostRelease | null
  credential: PostCredential | null
  // Whether the website checked the credential and records it.
  verified: boolean
}
// A record as lists show it: whether the text changed since its release.
export interface PostState extends PostRecord { changed: boolean }
export interface PostOverview extends PostState { documentTitle: string; siteName: string | null }
// Files already in the post are named by file; new ones by the token the main
// process issued when the writer chose them.
export type PostImageChoice = { alt: string; file: string } | { alt: string; token: string }
export type PostAttachmentChoice = { title: string; file: string } | { title: string; token: string }
export interface PublishRequest {
  siteId: string
  documentId: string
  headingId: string | null
  status: PostStatus
  fields: PostFields
  cover: PostImageChoice | null
  images: PostImageChoice[]
  attachments: PostAttachmentChoice[]
}
export type FilePick = 'cover' | 'gallery' | 'attachments'
export interface PickedFile { token: string; name: string; size: number }
export interface SiteCategory { id: string; label: string }
// The writer's author identity; the private key stays in the main process.
export interface AuthorSummary { name: string; did: string }
export interface CharacterCounts { written: number; pasted: number; imported: number; ai: number }
// What the Publish dialog shows about a post's authorship before it is signed.
export interface AuthorshipPreview { author: AuthorSummary | null; characters: CharacterCounts; typed: number; activeMinutes: number; intact: boolean }
// A website added in Settings. Its API key stays in the main process.
export interface SiteSummary { id: string; name: string; endpoint: string; categories: SiteCategory[] }
