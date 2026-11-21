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

// A published document or linked section. Image keys name objects in the
// site's R2 bucket; `obsolete` keys are removed once the site has rebuilt.
export interface PostImage { key: string; type: string; alt: string; name: string }
export interface PostFields { title: string; slug: string; summary: string; date: string; tags: string[] }
export interface PostRecord extends PostFields {
  id: string
  documentId: string
  headingId: string | null
  locale: string
  cover: PostImage | null
  images: PostImage[]
  obsolete: string[]
  publishedAt: number
  deployPending: boolean
  removed: boolean
}
// Images already in the post are named by key; new images by the token the
// main process issued when the writer chose the file.
export type PostImageChoice = { alt: string; key: string } | { alt: string; token: string }
export interface PublishRequest {
  documentId: string
  headingId: string | null
  fields: PostFields
  cover: PostImageChoice | null
  images: PostImageChoice[]
}
export interface PublishResult { post: PostRecord | null; deployError: string | null }
export interface PickedImage { token: string; name: string; size: number }
export interface SiteStatus { connected: boolean; accountId: string | null; databaseId: string | null; bucket: string | null; error: string | null }
