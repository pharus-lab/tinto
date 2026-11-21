import type { DocumentRecord, Version, Workspace, LibraryState, DraftChange, DraftResolution, PickedImage, PostRecord, PublishRequest, SiteSummary } from './project-types'

import type { DictionaryPack } from './dictionary-packs'
import type { DictionaryData } from './spelling'

import type { ExportFormat, InputFile } from './exchange'
import type { Manuscript } from './model'

import type { BackupStatus } from './backup-window'
import type { DriveBackup } from './drive'

export interface Desktop {
  backupStatus(): Promise<BackupStatus>
  connectDrive(): Promise<BackupStatus>
  disconnectDrive(): Promise<BackupStatus>
  enableBackup(enabled: boolean): Promise<BackupStatus>
  backUp(): Promise<BackupStatus>
  backupList(): Promise<DriveBackup[]>
  restoreBackup(id: string): Promise<string | null>
  openRestored(path: string): Promise<Workspace>
  online(): Promise<void>
  sites(): Promise<SiteSummary[]>
  addSite(endpoint: string, key: string): Promise<SiteSummary>
  testSite(id: string): Promise<SiteSummary>
  removeSite(id: string): Promise<void>
  posts(documentId: string, headingId: string | null): Promise<PostRecord[]>
  pickImages(multiple: boolean): Promise<PickedImage[]>
  publishPost(request: PublishRequest): Promise<PostRecord>
  unpublishPost(siteId: string, documentId: string, headingId: string | null): Promise<void>
  pickFile(): Promise<InputFile | null>
  exportFile(format: ExportFormat, title: string, doc: Manuscript): Promise<boolean>
  listPacks(): Promise<DictionaryPack[]>
  readPack(code: string): Promise<DictionaryData>
  installPack(code: string): Promise<void>
  createDraft(id: string, headingId: string | null, title: string): Promise<DocumentRecord>
  reviewDraft(id: string): Promise<DraftChange[]>
  applyDraft(id: string, resolutions: DraftResolution[]): Promise<{ source: DocumentRecord; draft: DocumentRecord }>
  platform: string
  library(): Promise<LibraryState>
  chooseFolder(folder?: string): Promise<LibraryState | null>
  newFolder(): Promise<LibraryState | null>
  sample(): Promise<Workspace>
  workspace(): Promise<Workspace>
  open(item?: number | string): Promise<Workspace | null>
  create(language: string): Promise<Workspace | null>
  save(path: string, projectId: string, document: DocumentRecord): string | null
  versions(documentId: string): Promise<Version[]>
  nameVersion(documentId: string, name: string): Promise<void>
  restore(documentId: string, versionId: string): Promise<DocumentRecord>
  deleteVersion(documentId: string, versionId: string): Promise<void>
}

declare global {
  interface Window { tinto: Desktop }
}
