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
