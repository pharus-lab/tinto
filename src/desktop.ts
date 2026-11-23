import type { AuthorSummary, AuthorshipPreview, ManuscriptFont, DocumentRecord, Version, Workspace, LibraryState, DraftChange, DraftResolution, FilePick, PickedFile, PostOverview, PostState, PublishRequest, SiteSummary, TranslatorSummary } from './project-types'
import type { TranslationResult, TranslationSource } from './translation'
import type { WritingRequest, WritingResponse } from './writing-types'

import type { ExportFormat, InputFile } from './exchange'
import type { Manuscript } from './model'

import type { BackupStatus } from './backup-window'
import type { DriveBackup } from './drive'

export interface Desktop {
  checkWriting(request: WritingRequest): Promise<WritingResponse>
  backupStatus(): Promise<BackupStatus>
  connectDrive(): Promise<BackupStatus>
  disconnectDrive(): Promise<BackupStatus>
  enableBackup(enabled: boolean): Promise<BackupStatus>
  backUp(): Promise<BackupStatus>
  backupList(): Promise<DriveBackup[]>
  restoreBackup(id: string): Promise<string | null>
  openRestored(path: string): Promise<Workspace>
  online(): Promise<void>
  author(): Promise<AuthorSummary | null>
  createAuthor(name: string): Promise<AuthorSummary>
  renameAuthor(name: string): Promise<AuthorSummary>
  exportAuthor(passphrase: string): Promise<string | null>
  importAuthor(passphrase: string): Promise<AuthorSummary | null>
  authorship(documentId: string, headingId: string | null): Promise<AuthorshipPreview>
  recordWriting(path: string, projectId: string, documentId: string, kind: 'typing' | 'paste' | 'import' | 'translate', sample: WritingSample): void
  fonts(): Promise<ManuscriptFont[]>
  addFonts(characters: string): Promise<{ fonts: ManuscriptFont[]; added: string[] } | null>
  checkFont(id: string, characters: string): Promise<{ family: string; missing: string[] } | null>
  removeFont(id: string): Promise<ManuscriptFont[]>
  sites(): Promise<SiteSummary[]>
  addSite(endpoint: string, key: string): Promise<SiteSummary>
  testSite(id: string): Promise<SiteSummary>
  removeSite(id: string): Promise<void>
  posts(documentId: string, headingId: string | null): Promise<PostState[]>
  allPosts(): Promise<PostOverview[]>
  saveModule(values: { name: string; site: string }): Promise<{ path: string; updated: boolean } | null>
  copyText(text: string): Promise<void>
  openCloudflare(): Promise<void>
  pickFiles(kind: FilePick): Promise<PickedFile[]>
  publishPost(request: PublishRequest): Promise<PostState & { pair?: PostState }>
  previewPost(request: PublishRequest): Promise<string>
  onPublishProgress(listener: (done: number, total: number) => void): () => void
  translatorStatus(): Promise<TranslatorSummary | null>
  saveTranslator(provider: string, key: string, model: string): Promise<TranslatorSummary>
  testTranslator(): Promise<TranslatorSummary>
  removeTranslator(): Promise<void>
  translate(source: TranslationSource, from: string, to: string): Promise<TranslationResult>
  translateTexts(texts: string[], from: string, to: string): Promise<string[]>
  onTranslateProgress(listener: (done: number, total: number) => void): () => void
  unpublishPost(siteId: string, documentId: string, headingId: string | null): Promise<void>
  pickFile(): Promise<InputFile | null>
  // font is the manuscript font choice; note says when the font could only be named.
  exportFile(format: ExportFormat, title: string, doc: Manuscript, language: string, font: string): Promise<false | { note: string | null }>
  createDraft(id: string, headingId: string | null, title: string): Promise<DocumentRecord>
  reviewDraft(id: string): Promise<DraftChange[]>
  applyDraft(id: string, resolutions: DraftResolution[]): Promise<{ source: DocumentRecord; draft: DocumentRecord }>
  platform: string
  // Google Drive backup is shown only when TINTO_EXPERIMENTAL=1.
  experimental: boolean
  version: string
  // A newer release on GitHub, checked once when Tinto opens.
  // Milliseconds between checks while Tinto stays open: a day.
  updateInterval: number
  checkForUpdate(): Promise<{ version: string; url: string } | null>
  openRelease(): Promise<void>
  library(): Promise<LibraryState>
  chooseFolder(folder?: string): Promise<LibraryState | null>
  newFolder(): Promise<LibraryState | null>
  sample(): Promise<Workspace>
  workspace(): Promise<Workspace>
  open(item?: number | string): Promise<Workspace | null>
  create(): Promise<Workspace | null>
  renameProject(path: string, title: string): Promise<LibraryState>
  deleteProject(path: string): Promise<LibraryState>
  deleteDocument(path: string, id: string): Promise<LibraryState>
  moveDocument(source: string, id: string, destination: string): Promise<LibraryState>
  undoMove(): Promise<LibraryState>
  save(path: string, projectId: string, document: DocumentRecord): string | null
  versions(documentId: string): Promise<Version[]>
  nameVersion(documentId: string, name: string): Promise<void>
  restore(documentId: string, versionId: string): Promise<DocumentRecord>
  deleteVersion(documentId: string, versionId: string): Promise<void>
}

// Counts and timing only: how many characters were typed, deleted, pasted or
// imported, the active time, and keystroke intervals by band. Never the text.
export interface WritingSample { typed?: number; deleted?: number; activeMs?: number; intervals?: number[]; characters?: number }

declare global {
  interface Window { tinto: Desktop }
}
