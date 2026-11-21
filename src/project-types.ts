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

// A document or linked section published on one website. Image files are
// named by their content; `name` is the local file name and stays in Tinto.
export interface PostImage { file: string; type: string; alt: string; name: string }
export interface PostFields { title: string; slug: string; summary: string; date: string; tags: string[] }
export interface PostRecord extends PostFields {
  id: string
  siteId: string
  documentId: string
  headingId: string | null
  language: string
  cover: PostImage | null
  images: PostImage[]
  url: string | null
  publishedAt: number
}
// Images already in the post are named by file; new images by the token the
// main process issued when the writer chose the file.
export type PostImageChoice = { alt: string; file: string } | { alt: string; token: string }
export interface PublishRequest {
  siteId: string
  documentId: string
  headingId: string | null
  fields: PostFields
  cover: PostImageChoice | null
  images: PostImageChoice[]
}
export interface PickedImage { token: string; name: string; size: number }
// A website added in Settings. Its API key stays in the main process.
export interface SiteSummary { id: string; name: string; endpoint: string }
