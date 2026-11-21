import { randomUUID } from 'node:crypto'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { compareDraft, forkDraft, reconcileDraft, type DraftBaseline } from './drafts'
import type { DocumentRecord, DraftChange, DraftResolution, PostRecord, Project, Version } from './project-types'

const APPLICATION_ID = 0x54494e54 // TINT
const VERSION_INTERVAL = 5 * 60_000
const RETENTION = 30 * 24 * 60 * 60_000
export interface MoveOrigin {
  projectId: string
  destinationId: string
  rowid: number
  drafts: { id: string; source: string; baseline: string }[]
}
const DRAFT_SCHEMA = `
  CREATE TABLE draft_baselines (draft_id TEXT PRIMARY KEY REFERENCES documents(id), content TEXT NOT NULL);
  PRAGMA user_version = 2;
`
// Publication details live beside the documents rather than inside them, so
// restoring a version or creating a draft never forgets or copies a post's id.
// Each website keeps its own post of a document or section.
const POST_SCHEMA = `
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
    heading_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, UNIQUE (site_id, document_id, heading_id)
  );
  PRAGMA user_version = 4;
`

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = action()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// JSON preserves the full tree as written by the editor, including inactive
// options. The same payload is used for the current state and its versions.
function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return JSON.parse(String(row.content))
}

export class ProjectStore {
  private db: DatabaseSync
  private now: () => number

  constructor(path: string, now: () => number = Date.now) {
    // Opening a missing project must never silently create an empty database.
    closeSync(openSync(path, 'r+'))
    this.db = new DatabaseSync(path)
    this.now = now
    try {
      if (this.db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) {
        throw new Error('This file is not a Tinto project.')
      }
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version === 1) transaction(this.db, () => { this.db.exec(DRAFT_SCHEMA); this.db.exec(POST_SCHEMA) })
      else if (version === 2) transaction(this.db, () => this.db.exec(POST_SCHEMA))
      // Version 3 came only from unreleased builds that published to a single
      // site, before any site could be connected. Its table has no site column.
      else if (version === 3) transaction(this.db, () => { this.db.exec('DROP TABLE posts'); this.db.exec(POST_SCHEMA) })
      else if (version !== 4) {
        throw new Error('This project requires a different version of Tinto.')
      }
      this.tick()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  static create(path: string, title: string, firstDocument?: DocumentRecord, now: () => number = Date.now): ProjectStore {
    // Reserve the filename before SQLite opens it. Existing projects stay intact.
    closeSync(openSync(path, 'wx', 0o600))
    try {
      const db = new DatabaseSync(path)
      try {
        transaction(db, () => {
          db.exec(`
            PRAGMA application_id = ${APPLICATION_ID};
            CREATE TABLE project (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL, dirty_since INTEGER);
            CREATE TABLE versions (
              id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
              time INTEGER NOT NULL, name TEXT, content TEXT NOT NULL
            );
            CREATE INDEX document_history ON versions(document_id, time);
            ${DRAFT_SCHEMA}
            ${POST_SCHEMA}
          `)
          db.prepare('INSERT INTO project VALUES (?, ?)').run(randomUUID(), title)
          if (firstDocument) db.prepare('INSERT INTO documents (id, content) VALUES (?, ?)').run(firstDocument.id, JSON.stringify(firstDocument))
        })
      } finally {
        db.close()
      }
      return new ProjectStore(path, now)
    } catch (error) {
      unlinkSync(path)
      throw error
    }
  }

  read(): Project {
    const project = this.db.prepare('SELECT id, title FROM project').get()!
    const documents = this.db.prepare('SELECT content FROM documents ORDER BY rowid').all().map(documentFromRow)
    return { id: String(project.id), title: String(project.title), documents }
  }

  renameProject(title: string) {
    this.db.prepare('UPDATE project SET title = ?').run(title)
  }

  deleteDocument(id: string) {
    transaction(this.db, () => this.removeDocumentRows(id))
  }

  private removeDocumentRows(id: string) {
    this.db.prepare(`DELETE FROM draft_baselines WHERE draft_id = ? OR draft_id IN
      (SELECT id FROM documents WHERE json_extract(content, '$.source.documentId') = ?)`).run(id, id)
    this.db.prepare(`UPDATE documents SET content = json_remove(content, '$.source')
      WHERE json_extract(content, '$.source.documentId') = ?`).run(id)
    this.db.prepare('DELETE FROM versions WHERE document_id = ?').run(id)
    // Posts stay on their websites; only this project's record of them goes.
    this.db.prepare('DELETE FROM posts WHERE document_id = ?').run(id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  moveDocument(id: string, destination: string, undo?: MoveOrigin): MoveOrigin {
    // Validate the destination and migrate older projects before attaching it for the move.
    new ProjectStore(destination).close()
    this.db.prepare('ATTACH DATABASE ? AS destination').run(pathToFileURL(destination).href + '?mode=rw')
    try {
      return transaction(this.db, () => {
        const original = this.db.prepare(`SELECT d.rowid, p.id AS projectId, other.id AS destinationId
          FROM main.documents d, main.project p, destination.project other WHERE d.id = ?`).get(id)
        if (!original) throw Error('This document is no longer in the project.')
        if (undo && (original.projectId !== undo.destinationId || original.destinationId !== undo.projectId)) throw Error('The project files have changed since the move.')
        if (this.db.prepare('SELECT 1 FROM destination.documents WHERE id = ?').get(id)) throw Error('That project already contains this document.')
        const drafts = this.db.prepare(`SELECT d.id, json_extract(d.content, '$.source') AS source, b.content AS baseline
          FROM main.documents d JOIN main.draft_baselines b ON b.draft_id = d.id
          WHERE d.id = ? OR json_extract(d.content, '$.source.documentId') = ?`).all(id, id)
          .map(row => ({ id: String(row.id), source: String(row.source), baseline: String(row.baseline) }))
        if (undo && drafts.length) throw Error('This document now has draft links in its new project. Move it from Home to review those links.')
        let position = undo?.rowid ?? null
        if (position !== null && this.db.prepare('SELECT 1 FROM destination.documents WHERE rowid = ?').get(position)) position = null
        this.db.prepare(`INSERT INTO destination.documents (rowid, id, content, dirty_since)
          SELECT ?, id, json_remove(content, '$.source'), dirty_since FROM main.documents WHERE id = ?`).run(position, id)
        this.db.prepare(`INSERT INTO destination.versions (id, document_id, time, name, content)
          SELECT id, document_id, time, name, content FROM main.versions WHERE document_id = ? ORDER BY rowid`).run(id)
        // Published posts move with the document, so it keeps updating the same posts.
        this.db.prepare(`INSERT INTO destination.posts (id, site_id, document_id, heading_id, content)
          SELECT id, site_id, document_id, heading_id, content FROM main.posts WHERE document_id = ?`).run(id)
        this.removeDocumentRows(id)
        for (const draft of undo?.drafts ?? []) {
          // Restore the relationship onto the current text so later edits survive Undo.
          const restored = this.db.prepare(`UPDATE destination.documents SET content = json_set(content, '$.source', json(?))
            WHERE id = ? AND EXISTS (SELECT 1 FROM destination.documents WHERE id = json_extract(?, '$.documentId'))`).run(draft.source, draft.id, draft.source)
          if (restored.changes) this.db.prepare('INSERT INTO destination.draft_baselines (draft_id, content) VALUES (?, ?)').run(draft.id, draft.baseline)
        }
        return { projectId: String(original.projectId), destinationId: String(original.destinationId), rowid: Number(original.rowid), drafts }
      })
    } finally { this.db.exec('DETACH DATABASE destination') }
  }

  save(doc: DocumentRecord): void {
    const time = this.now()
    transaction(this.db, () => {
      this.writeDocument(doc, time)
      this.snapshotDueDocuments(time)
    })
  }

  private writeDocument(doc: DocumentRecord, time: number) {
    this.db.prepare(`
      INSERT INTO documents (id, content, dirty_since) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content,
        dirty_since = COALESCE(documents.dirty_since, excluded.dirty_since)
      WHERE documents.content <> excluded.content
    `).run(doc.id, JSON.stringify(doc), time)
  }

  readDocument(id: string): DocumentRecord {
    const row = this.db.prepare('SELECT content FROM documents WHERE id = ?').get(id)
    if (!row) throw Error('This document is no longer in the project.')
    return documentFromRow(row)
  }

  createDraft(sourceId: string, headingId: string | null, title: string): DocumentRecord {
    return transaction(this.db, () => {
      const { draft, baseline } = forkDraft(this.readDocument(sourceId), headingId, title)
      this.writeDocument(draft, this.now())
      this.db.prepare('INSERT INTO draft_baselines (draft_id, content) VALUES (?, ?)').run(draft.id, JSON.stringify(baseline))
      return draft
    })
  }

  private readDraft(id: string) {
    const draft = this.readDocument(id)
    const row = this.db.prepare('SELECT content FROM draft_baselines WHERE draft_id = ?').get(id)
    if (!draft.source || !row) throw Error('This document is not an independent draft.')
    const baseline: DraftBaseline = JSON.parse(String(row.content))
    return { source: this.readDocument(draft.source.documentId), draft, baseline }
  }

  private writeBaseline(draftId: string, baseline: DraftBaseline) {
    this.db.prepare('UPDATE draft_baselines SET content = ? WHERE draft_id = ?').run(JSON.stringify(baseline), draftId)
  }

  reviewDraft(draftId: string): DraftChange[] {
    return transaction(this.db, () => {
      const { source, draft, baseline } = this.readDraft(draftId)
      const review = compareDraft(source, draft, baseline)
      if (baseline !== review.baseline) this.writeBaseline(draftId, review.baseline)
      return review.changes
    })
  }

  applyDraft(draftId: string, resolutions: DraftResolution[]): { source: DocumentRecord; draft: DocumentRecord } {
    return transaction(this.db, () => {
      const { source, draft, baseline } = this.readDraft(draftId)
      const result = reconcileDraft(source, draft, baseline, resolutions)
      const time = this.now()
      this.writeDocument(result.source, time)
      this.writeDocument(result.draft, time)
      this.writeBaseline(draftId, result.baseline)
      this.snapshotDueDocuments(time)
      return { source: result.source, draft: result.draft }
    })
  }

  projectId(): string {
    return String(this.db.prepare('SELECT id FROM project').get()!.id)
  }

  post(siteId: string, documentId: string, headingId: string | null): PostRecord | null {
    const row = this.db.prepare('SELECT content FROM posts WHERE site_id = ? AND document_id = ? AND heading_id = ?').get(siteId, documentId, headingId ?? '')
    return row ? JSON.parse(String(row.content)) : null
  }

  posts(documentId: string, headingId: string | null): PostRecord[] {
    return this.db.prepare('SELECT content FROM posts WHERE document_id = ? AND heading_id = ? ORDER BY rowid').all(documentId, headingId ?? '')
      .map(row => JSON.parse(String(row.content)))
  }

  savePost(post: PostRecord): void {
    this.db.prepare(`
      INSERT INTO posts (id, site_id, document_id, heading_id, content) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content
    `).run(post.id, post.siteId, post.documentId, post.headingId ?? '', JSON.stringify(post))
  }

  deletePost(id: string): void {
    this.db.prepare('DELETE FROM posts WHERE id = ?').run(id)
  }

  versions(docId: string): Version[] {
    return this.db.prepare('SELECT id, name, time, content FROM versions WHERE document_id = ? ORDER BY time DESC, rowid DESC').all(docId).map(row => {
      const doc = documentFromRow(row)
      return { id: String(row.id), name: row.name === null ? null : String(row.name), time: Number(row.time), manuscript: doc.manuscript, language: doc.language }
    })
  }

  private capture(docId: string, name: string | null, time: number): void {
    const result = this.db.prepare(`
      INSERT INTO versions (id, document_id, name, time, content)
      SELECT ?, id, ?, ?, content FROM documents WHERE id = ?
    `).run(randomUUID(), name, time, docId)
    if (!result.changes) throw new Error('This document is no longer in the project.')
    this.db.prepare('UPDATE documents SET dirty_since = NULL WHERE id = ?').run(docId)
  }

  snapshot(docId: string, name: string | null): void {
    transaction(this.db, () => this.capture(docId, name, this.now()))
  }

  restore(docId: string, versionId: string): DocumentRecord {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT content FROM versions WHERE id = ? AND document_id = ?').get(versionId, docId)
      if (!row) throw new Error('This version is no longer available.')
      const time = this.now()
      this.capture(docId, null, time)
      const current = this.readDocument(docId)
      const version = documentFromRow(row)
      current.manuscript = version.manuscript
      current.language = version.language
      this.db.prepare('UPDATE documents SET content = ?, dirty_since = ? WHERE id = ?').run(JSON.stringify(current), time, docId)
      return current
    })
  }

  deleteVersion(docId: string, id: string): void {
    this.db.prepare('DELETE FROM versions WHERE document_id = ? AND id = ?').run(docId, id)
  }

  private snapshotDueDocuments(time: number): void {
    const due = this.db.prepare('SELECT id FROM documents WHERE dirty_since <= ?').all(time - VERSION_INTERVAL)
    for (const doc of due) this.capture(String(doc.id), null, time)
  }

  tick(): void {
    const time = this.now()
    transaction(this.db, () => {
      this.snapshotDueDocuments(time)
      this.db.prepare('DELETE FROM versions WHERE name IS NULL AND time < ?').run(time - RETENTION)
    })
  }

  backupTo(path: string): { id: string; title: string } {
    this.tick()
    this.db.prepare('VACUUM main INTO ?').run(path)
    const project = this.db.prepare('SELECT id, title FROM project').get()!
    return { id: String(project.id), title: String(project.title) }
  }

  static verifyBackup(path: string, projectId: string): void {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const valid = db.prepare('PRAGMA application_id').get()?.application_id === APPLICATION_ID
      if (!valid || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('SELECT id FROM project').get()?.id !== projectId) {
        throw Error('The downloaded file is not an intact backup of this project.')
      }
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (version < 1 || version > 4) throw Error('This backup requires a different version of Tinto.')
    } finally { db.close() }
  }

  close(): void {
    this.db.close()
  }
}
