import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { link, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ProjectStore } from './storage'

export interface DriveBackup { id: string; name: string; time: number; projectId: string; checksum: string }
type Upload = Pick<DriveBackup, 'name' | 'projectId' | 'checksum'>
interface DriveTransport {
  list(): Promise<DriveBackup[]>
  upload(path: string, item: Upload): Promise<DriveBackup>
  trash(id: string): Promise<void>
  download(id: string, path: string): Promise<void>
}

interface RemoteFile {
  id: string
  name: string
  createdTime: string
  sha256Checksum?: string
  appProperties?: { tintoType?: string; projectId?: string; checksum?: string }
}
const api = 'https://www.googleapis.com/drive/v3/files'
const fields = 'id,name,createdTime,sha256Checksum,appProperties'
const fileType = 'application/vnd.sqlite3'

function describe(file: RemoteFile): DriveBackup | null {
  const properties = file.appProperties
  if (properties?.tintoType !== 'project' || !properties.projectId || !properties.checksum || file.sha256Checksum !== properties.checksum) return null
  return { id: file.id, name: file.name, time: Date.parse(file.createdTime), projectId: properties.projectId, checksum: properties.checksum }
}

export class GoogleDrive implements DriveTransport {
  private token: () => Promise<string>
  constructor(token: () => Promise<string>) { this.token = token }

  private async request(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers)
    headers.set('Authorization', 'Bearer ' + await this.token())
    const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw Error('Google Drive returned HTTP ' + response.status + '. Check your connection and Drive access, then try again.')
    return response
  }

  private async files(query: string): Promise<RemoteFile[]> {
    const files: RemoteFile[] = []
    let token: string | undefined
    do {
      const params = new URLSearchParams({ q: 'trashed = false and ' + query, spaces: 'drive', fields: 'nextPageToken,files(' + fields + ')', pageSize: '1000', orderBy: 'createdTime desc' })
      if (token) params.set('pageToken', token)
      const response = await this.request(api + '?' + params)
      const page = await response.json() as { files: RemoteFile[]; nextPageToken?: string }
      files.push(...page.files)
      token = page.nextPageToken
    } while (token)
    return files
  }

  async list(): Promise<DriveBackup[]> {
    const files = await this.files("appProperties has { key='tintoType' and value='project' }")
    return files.map(describe).filter((file): file is DriveBackup => file !== null)
  }

  private async folder() {
    const folders = await this.files("mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='tintoType' and value='folder' }")
    if (folders.length) return folders[0].id
    const response = await this.request(api + '?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tinto Backups', mimeType: 'application/vnd.google-apps.folder', appProperties: { tintoType: 'folder' } }) })
    return (await response.json() as { id: string }).id
  }

  async upload(path: string, item: Upload): Promise<DriveBackup> {
    const bytes = await openAsBlob(path, { type: fileType })
    const metadata = { name: item.name, mimeType: fileType, parents: [await this.folder()], appProperties: { tintoType: 'project', projectId: item.projectId, checksum: item.checksum } }
    const session = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + fields, {
      method: 'POST', body: JSON.stringify(metadata),
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': fileType, 'X-Upload-Content-Length': String(bytes.size) }
    })
    const location = session.headers.get('Location')
    if (!location || new URL(location).origin !== 'https://www.googleapis.com') throw Error('Google Drive did not return an upload session.')
    const response = await this.request(location, { method: 'PUT', body: bytes })
    const backup = describe(await response.json() as RemoteFile)
    if (!backup || backup.checksum !== item.checksum || backup.projectId !== item.projectId) throw Error('Drive could not verify the uploaded project. Previous backups have been kept.')
    return backup
  }

  async trash(id: string): Promise<void> {
    await this.request(api + '/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })
  }

  async download(id: string, path: string): Promise<void> {
    const response = await this.request(api + '/' + encodeURIComponent(id) + '?alt=media')
    if (!response.body) throw Error('The backup download was empty.')
    await pipeline(response.body, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
  }
}

interface SuccessfulBackup { time: number; checksum: string; prune: boolean }
async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export class DriveBackups {
  private remote: DriveTransport
  private statePath: string
  private history: Record<string, SuccessfulBackup>
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0

  constructor(userData: string, remote: DriveTransport) {
    this.remote = remote
    this.statePath = join(userData, 'backup-status.json')
    this.history = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : {}
  }

  lastSuccess(projectId: string): number | null { return this.history[projectId]?.time ?? null }
  list(): Promise<DriveBackup[]> { return this.remote.list() }

  private saveHistory() {
    mkdirSync(dirname(this.statePath), { recursive: true })
    const temporary = this.statePath + '.' + randomUUID()
    try {
      writeFileSync(temporary, JSON.stringify(this.history), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    } finally { rmSync(temporary, { force: true }) }
  }

  resetLocalState() {
    this.generation++
    this.history = {}
    rmSync(this.statePath, { force: true })
  }

  async backup(store: ProjectStore, onlyIfChanged = false): Promise<boolean> {
    const temporary = mkdtempSync(join(tmpdir(), 'tinto-backup-'))
    const path = join(temporary, 'snapshot.tinto')
    const generation = this.generation
    const active = () => {
      if (generation !== this.generation) throw Error('Google Drive was disconnected.')
    }
    try {
      // Finish reading SQLite before yielding. The writer can now edit, close
      // the document or open another project while this fixed snapshot uploads.
      const project = store.backupTo(path)
      const send = async () => {
        const digest = await checksum(path)
        active()
        const old = this.history[project.id]
        const changed = !onlyIfChanged || old?.checksum !== digest
        if (changed) {
          const stamp = new Date().toISOString().replaceAll(':', '-')
          const backup = await this.remote.upload(path, { name: project.title + ' ' + stamp + '.tinto', projectId: project.id, checksum: digest })
          active()
          this.history[project.id] = { time: backup.time, checksum: digest, prune: true }
          this.saveHistory()
        }
        // A failed upload never reaches this point. If pruning itself fails,
        // the flag survives restart and the next attempt retries just pruning.
        if (this.history[project.id]?.prune) {
          const files = (await this.remote.list()).filter(file => file.projectId === project.id).sort((a, b) => b.time - a.time)
          for (const older of files.slice(5)) { active(); await this.remote.trash(older.id) }
          active()
          this.history[project.id].prune = false
          this.saveHistory()
        }
        return changed
      }
      const task = this.queue.then(send)
      this.queue = task.catch(() => {})
      return await task
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  async restore(fileId: string, destination: string): Promise<void> {
    const backup = (await this.remote.list()).find(file => file.id === fileId)
    if (!backup) throw Error('This backup is no longer available on Drive.')
    const directory = await mkdtemp(join(dirname(destination), '.tinto-restore-'))
    const temporary = join(directory, 'restored.tinto')
    try {
      await this.remote.download(fileId, temporary)
      if (await checksum(temporary) !== backup.checksum) throw Error('The downloaded project failed its checksum. Download it again.')
      ProjectStore.verifyBackup(temporary, backup.projectId)
      // The destination appears only after verification. An existing local
      // project cannot be overwritten if its name was chosen by mistake.
      await link(temporary, destination)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
