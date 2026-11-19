import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { listPacks, readPack, installPack } from './dictionary-packs'
import { registerBackups } from './backup-window'
import { pickInputFile, exportFile } from './file-dialogs'
import type { ExportFormat } from './exchange'
import type { Manuscript } from './model'
import { ProjectStore } from './storage'
import { newBlock, sampleManuscript } from './model'
import type { DocumentRecord, RecentProject, Workspace, DraftResolution } from './project-types'

app.setName('Tinto')
if (process.env.TINTO_USER_DATA) app.setPath('userData', process.env.TINTO_USER_DATA)
protocol.registerSchemesAsPrivileged([{ scheme: 'tinto', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const entry = 'tinto://app/index.html'
let store: ProjectStore
let projectPath: string
let currentProjectId: string
let recent: RecentProject[] = []
let window: BrowserWindow | null = null
const libraryFile = () => join(app.getPath('userData'), 'projects.json')

function workspace(): Workspace {
  return { project: store.read(), path: projectPath, recent }
}

function activate(path: string, project: ProjectStore): Workspace {
  const data = project.read()
  const next = [{ path, title: data.title }, ...recent.filter(item => item.path !== path)]
  try {
    mkdirSync(dirname(libraryFile()), { recursive: true })
    writeFileSync(libraryFile() + '.tmp', JSON.stringify(next), 'utf8')
    renameSync(libraryFile() + '.tmp', libraryFile())
  } catch (error) {
    project.close()
    throw error
  }
  store?.close()
  store = project
  projectPath = path
  currentProjectId = data.id
  recent = next
  return { project: data, path, recent }
}

function loadLibrary() {
  if (existsSync(libraryFile())) recent = JSON.parse(readFileSync(libraryFile(), 'utf8'))
  const last = recent.find(item => existsSync(item.path))
  if (last) return activate(last.path, new ProjectStore(last.path))
  const directory = join(app.getPath('userData'), 'Projects')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'The long way home.tinto')
  if (existsSync(path)) return activate(path, new ProjectStore(path))
  const title = 'The long way home'
  const document = { id: randomUUID(), title, language: 'en', manuscript: sampleManuscript() }
  return activate(path, ProjectStore.create(path, title, document))
}

function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.senderFrame?.url !== entry || event.sender !== window?.webContents) throw Error('Unknown editor window.')
}

function registerProjectActions() {
  ipcMain.handle('file:pick', event => { trusted(event); return pickInputFile(window!) })
  ipcMain.handle('file:export', (event, format: ExportFormat, title: string, doc: Manuscript) => {
    trusted(event)
    return exportFile(window!, format, title, doc)
  })
  ipcMain.handle('draft:create', (event, id: string, heading: string | null, title: string) => {
    trusted(event)
    return store.createDraft(id, heading, title)
  })
  ipcMain.handle('draft:review', (event, id: string) => { trusted(event); return store.reviewDraft(id) })
  ipcMain.handle('draft:apply', (event, id: string, resolutions: DraftResolution[]) => { trusted(event); return store.applyDraft(id, resolutions) })
  ipcMain.handle('packs:list', event => { trusted(event); return listPacks(app.getPath('userData')) })
  ipcMain.handle('packs:read', (event, code: string) => { trusted(event); return readPack(app.getPath('userData'), code) })
  ipcMain.handle('packs:install', (event, code: string) => { trusted(event); return installPack(app.getPath('userData'), code) })
  ipcMain.handle('workspace', event => { trusted(event); return workspace() })
  ipcMain.handle('project:open', async (event, index?: number) => {
    trusted(event)
    let path = index === undefined ? undefined : recent[index]?.path
    if (!path) {
      const choice = await dialog.showOpenDialog(window!, { title: 'Open a Tinto project', properties: ['openFile'], filters: [{ name: 'Tinto project', extensions: ['tinto'] }] })
      if (choice.canceled) return null
      path = choice.filePaths[0]
    }
    return path === projectPath ? workspace() : activate(path, new ProjectStore(path))
  })
  ipcMain.handle('project:create', async (event, language: string) => {
    trusted(event)
    const choice = await dialog.showSaveDialog(window!, { title: 'Create a Tinto project', defaultPath: 'Untitled.tinto', filters: [{ name: 'Tinto project', extensions: ['tinto'] }], buttonLabel: 'Create project' })
    if (!choice.filePath || choice.canceled) return null
    const path = choice.filePath
    const title = basename(path, extname(path))
    const document: DocumentRecord = { id: randomUUID(), title, language, manuscript: { type: 'doc', content: [newBlock()] } }
    return activate(path, ProjectStore.create(path, title, document))
  })
  ipcMain.on('document:save', (event, id: string, document: DocumentRecord) => {
    try {
      trusted(event)
      if (id !== currentProjectId) throw Error('This project is no longer open.')
      store.save(document)
      event.returnValue = null
    } catch (error) { event.returnValue = String(error) }
  })
  ipcMain.handle('version:list', (e, id: string) => { trusted(e); return store.versions(id) })
  ipcMain.handle('version:name', (e, id: string, name: string) => { trusted(e); store.snapshot(id, name) })
  ipcMain.handle('version:restore', (e, id: string, v: string) => { trusted(e); return store.restore(id, v) })
  ipcMain.handle('version:delete', (e, id: string, v: string) => { trusted(e); store.deleteVersion(id, v) })
}

async function openWindow() {
  window = new BrowserWindow({
    title: 'Tinto', width: 1240, height: 840, minWidth: 740, minHeight: 520, show: false,
    backgroundColor: '#FCFAF6', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-prevent-unload', () => {
    dialog.showErrorBox('Tinto could not save this project', 'The editor is still open. Check the save message and try saving again.')
  })
  window.on('closed', () => { window = null })
  window.once('ready-to-show', () => window?.show())
  await window.loadURL(entry)
}

const primaryWindow = app.requestSingleInstanceLock()
if (!primaryWindow) app.quit()
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore()
  window?.focus()
})

if (primaryWindow) app.whenReady().then(async () => {
  protocol.handle('tinto', async request => {
    const url = new URL(request.url)
    const path = url.pathname.slice(1)
    const mime: Record<string, string> = { html: 'text/html', css: 'text/css', js: 'application/javascript', mjs: 'application/javascript', aff: 'text/plain', dic: 'text/plain' }
    if (url.host !== 'app' || !/^(index\.html|app\.js|pdf(?:\.worker)?\.mjs|(?:styles|spelling|draft)\.css|dictionaries\/(en|es)\.(aff|dic))$/.test(path)) return new Response(null, { status: 404 })
    const bytes = await readFile(join(__dirname, path))
    return new Response(bytes, { headers: { 'Content-Type': mime[extname(path).slice(1)] + '; charset=utf-8' } })
  })
  loadLibrary()
  registerProjectActions()
  registerBackups({ window: () => window!, project: () => ({ store, path: projectPath, id: currentProjectId }), open: path => activate(path, new ProjectStore(path)), trusted })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  await openWindow()
  const timer = setInterval(() => {
    try { store.tick() }
    catch (error) { dialog.showErrorBox('Tinto could not save a history snapshot', String(error)) }
  }, 30_000)
  timer.unref()
  app.on('activate', () => { if (!window) void openWindow() })
}).catch(error => { dialog.showErrorBox('Tinto could not open the project', String(error)); app.quit() })

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => store?.close())
