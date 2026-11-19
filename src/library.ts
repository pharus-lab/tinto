import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { DocumentRecord, LibraryState, RecentProject, Workspace } from './project-types'
import { ProjectStore } from './storage'

interface LibraryPreferences {
  folder: string | null
  folders: string[]
  recent: RecentProject[]
}

export class ProjectLibrary {
  private preferences: LibraryPreferences = { folder: null, folders: [], recent: [] }
  private current: { path: string; id: string; store: ProjectStore } | null = null

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const saved: LibraryPreferences | RecentProject[] = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(saved)) {
      // Older installations remembered files before the writer could choose a folder.
      this.preferences.recent = saved
      this.preferences.folders = [...new Set(saved.map(item => dirname(item.path)))]
      return
    }
    this.preferences = saved
    if (!saved.folder || !statSync(saved.folder, { throwIfNoEntry: false })?.isDirectory()) {
      this.preferences.folder = null
      return
    }
    this.restoreProject(saved.folder)
  }

  get folder(): string | null { return this.preferences.folder }

  get activeFolder(): string {
    if (!this.preferences.folder) throw Error('Choose a Tinto folder first.')
    return this.preferences.folder
  }

  get store(): ProjectStore {
    if (!this.current) throw Error('Open a project first.')
    return this.current.store
  }

  get activeProject(): { path: string; id: string } | null {
    if (!this.current) return null
    return { path: this.current.path, id: this.current.id }
  }

  private remember(next: LibraryPreferences) {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
    this.preferences = next
  }

  private inFolder(folder: string) {
    return { ...this.preferences, folder, folders: [folder, ...this.preferences.folders.filter(path => path !== folder)] }
  }

  private projects(folder: string): RecentProject[] {
    const titles = new Map(this.preferences.recent.map(item => [item.path, item.title]))
    return readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.tinto')
      .map(entry => {
        const path = join(folder, entry.name)
        return { path, title: titles.get(path) ?? basename(entry.name, extname(entry.name)) }
      }).sort((a, b) => a.title.localeCompare(b.title))
  }

  state(): LibraryState {
    const { folder, folders } = this.preferences
    return { folder, folders, projects: folder ? this.projects(folder) : [], workspace: this.current ? this.workspace() : null }
  }

  workspace(): Workspace {
    if (!this.current) throw Error('Open a project first.')
    return { project: this.current.store.read(), path: this.current.path, recent: this.preferences.recent }
  }

  private restoreProject(folder: string) {
    const last = this.preferences.recent.find(item => dirname(item.path) === folder && existsSync(item.path))
    if (!last) return
    try { this.open(last.path) }
    catch { /* The project can be retried from Home if the file is unreadable. */ }
  }

  selectFolder(folder: string, remembered = false): LibraryState {
    if (remembered && !this.preferences.folders.includes(folder)) throw Error('Choose this folder from the folder picker.')
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw Error('This folder is unavailable. Choose another folder.')
    if (folder !== this.preferences.folder) {
      // Check the folder can be listed before closing the previous project.
      this.projects(folder)
      this.remember(this.inFolder(folder))
      this.close()
      this.restoreProject(folder)
    }
    return this.state()
  }

  activate(path: string, project: ProjectStore): Workspace {
    try {
      const data = project.read()
      const recent = [{ path, title: data.title }, ...this.preferences.recent.filter(item => item.path !== path)]
      this.remember({ ...this.inFolder(dirname(path)), recent })
      this.close()
      this.current = { path, id: data.id, store: project }
      return { project: data, path, recent }
    } catch (error) {
      project.close()
      throw error
    }
  }

  open(path: string): Workspace {
    return path === this.current?.path ? this.workspace() : this.activate(path, new ProjectStore(path))
  }

  openListed(item: number | string): Workspace {
    const path = typeof item === 'number' ? this.preferences.recent[item]?.path : this.projects(this.activeFolder).find(project => project.path === item)?.path
    if (!path) throw Error('Choose a project from the current folder.')
    return this.open(path)
  }

  save(path: string, id: string, doc: DocumentRecord) {
    if (this.current?.path === path && this.current.id === id) return this.current.store.save(doc)
    if (!this.preferences.recent.some(item => item.path === path)) throw Error('The original project is unavailable.')
    const previous = new ProjectStore(path)
    try {
      if (previous.read().id !== id) throw Error('The original project file has changed.')
      previous.save(doc)
    } finally { previous.close() }
  }

  tick() { this.current?.store.tick() }

  close() {
    this.current?.store.close()
    this.current = null
  }
}
