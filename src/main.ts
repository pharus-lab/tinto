import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerBackups } from './backup-window'
import { registerPublishing } from './publish-window'
import { registerTranslation } from './translator'
import { registerUpdates } from './updates'
import { registerFonts } from './font-window'
import { WritingService } from './writing-service'
import { FONT_TYPES, FontLibrary } from './fonts'
import { pickInputFile, exportFile } from './file-dialogs'
import type { ExportFormat } from './exchange'
import type { Manuscript } from './model'
import { ProjectStore } from './storage'
import { ProjectLibrary } from './library'
import { sampleManuscript } from './model'
import type { DocumentRecord, DraftResolution } from './project-types'

app.setName('Tinto')
if (process.platform === 'linux') app.setDesktopName('tinto.desktop')
if (process.env.TINTO_USER_DATA) app.setPath('userData', process.env.TINTO_USER_DATA)
protocol.registerSchemesAsPrivileged([{ scheme: 'tinto', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const entry = 'tinto://app/index.html'
let library: ProjectLibrary
let window: BrowserWindow | null = null
let fonts: FontLibrary
let writing: WritingService
// Functions not yet ready for everyone appear only with TINTO_EXPERIMENTAL=1.
const experimental = process.env.TINTO_EXPERIMENTAL === '1'

function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.senderFrame?.url !== entry || event.sender !== window?.webContents) throw Error('Unknown editor window.')
}

// Moving, renaming and deleting wait for any post being published, so its record
// is saved in the project before the project or document changes.
function registerProjectActions(updateBackupPath: (path: string, destination?: string) => void, publishing: () => Promise<unknown>) {
  ipcMain.handle('file:pick', event => { trusted(event); return pickInputFile(window!) })
  ipcMain.handle('file:export', async (event, format: ExportFormat, title: string, doc: Manuscript, language: string, font: unknown) => {
    trusted(event)
    return exportFile(window!, format, title, doc, language, await fonts.exportFont(typeof font === 'string' ? font : 'book'))
  })
  ipcMain.handle('draft:create', (event, id: string, heading: string | null, title: string) => {
    trusted(event)
    return library.store.createDraft(id, heading, title)
  })
  ipcMain.handle('draft:review', (event, id: string) => { trusted(event); return library.store.reviewDraft(id) })
  ipcMain.handle('draft:apply', (event, id: string, resolutions: DraftResolution[]) => { trusted(event); return library.store.applyDraft(id, resolutions) })
  ipcMain.handle('library', event => { trusted(event); return library.state() })
  ipcMain.handle('library:choose', async (event, folder?: string) => {
    trusted(event)
    if (folder !== undefined) return library.selectFolder(folder, true)
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose a Tinto folder', buttonLabel: 'Choose folder',
      defaultPath: library.folder ?? app.getPath('documents'), properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : library.selectFolder(result.filePaths[0])
  })
  ipcMain.handle('library:create', async event => {
    trusted(event)
    const parent = library.folder
    const result = await dialog.showSaveDialog(window!, {
      title: 'Create a Tinto folder', buttonLabel: 'Create folder', nameFieldLabel: 'Folder name:',
      defaultPath: join(parent ? dirname(parent) : app.getPath('documents'), 'Tinto')
    })
    if (result.canceled || !result.filePath) return null
    if (existsSync(result.filePath)) throw Error('This name is already in use. Choose an existing folder or enter a new name.')
    mkdirSync(result.filePath)
    return library.selectFolder(result.filePath)
  })
  ipcMain.handle('project:sample', event => {
    trusted(event)
    const title = 'The long way home'
    const path = join(library.activeFolder, title + '.tinto')
    if (existsSync(path)) return library.open(path)
    const document = { id: randomUUID(), title, language: 'en', manuscript: sampleManuscript() }
    return library.activate(path, ProjectStore.create(path, title, document))
  })
  ipcMain.handle('workspace', event => { trusted(event); return library.workspace() })
  ipcMain.handle('project:rename', async (event, path: string, title: string) => {
    trusted(event)
    await publishing()
    const destination = library.renameProject(path, title)
    updateBackupPath(path, destination)
    return library.state()
  })
  ipcMain.handle('project:delete', async (event, path: string) => {
    trusted(event)
    await publishing()
    await library.deleteProject(path, file => shell.trashItem(file))
    updateBackupPath(path)
    return library.state()
  })
  ipcMain.handle('document:delete', async (event, path: string, id: string) => {
    trusted(event)
    await publishing()
    if (library.activeProject?.path !== path) throw Error('Open the original project first.')
    library.store.deleteDocument(id)
    return library.state()
  })
  ipcMain.handle('document:move', async (event, source: string, id: string, destination: string) => {
    trusted(event)
    await publishing()
    return library.moveDocument(source, id, destination)
  })
  ipcMain.handle('document:undo-move', async event => { trusted(event); await publishing(); return library.undoMove() })
  ipcMain.handle('project:open', async (event, item?: number | string) => {
    trusted(event)
    if (item !== undefined) return library.openListed(item)
    const choice = await dialog.showOpenDialog(window!, { title: 'Open a Tinto project', defaultPath: library.activeFolder, properties: ['openFile'], filters: [{ name: 'Tinto project', extensions: ['tinto'] }] })
    return choice.canceled ? null : library.open(choice.filePaths[0])
  })
  ipcMain.handle('project:create', async event => {
    trusted(event)
    const choice = await dialog.showSaveDialog(window!, { title: 'Create a Tinto project', defaultPath: join(library.activeFolder, 'Untitled.tinto'), filters: [{ name: 'Tinto project', extensions: ['tinto'] }], buttonLabel: 'Create project' })
    if (!choice.filePath || choice.canceled) return null
    const path = choice.filePath
    const title = basename(path, extname(path))
    return library.activate(path, ProjectStore.create(path, title))
  })
  ipcMain.on('app:experimental', event => { event.returnValue = experimental })
  ipcMain.on('document:save', (event, path: string, id: string, document: DocumentRecord) => {
    try {
      trusted(event)
      library.save(path, id, document)
      event.returnValue = null
    } catch (error) { event.returnValue = String(error) }
  })
  // Typing, pasting and importing measured in the editor: counts and timing only.
  ipcMain.on('authorship:record', (event, path: string, projectId: string, documentId: string, kind: string, sample: object) => {
    try {
      trusted(event)
      if (kind === 'typing' || kind === 'paste' || kind === 'import' || kind === 'translate') library.recordWriting(String(path), String(projectId), String(documentId), kind, sample ?? {})
      event.returnValue = null
    } catch (error) {
      console.error('Tinto could not record writing evidence:', error)
      event.returnValue = String(error)
    }
  })
  ipcMain.handle('version:list', (e, id: string) => { trusted(e); return library.store.versions(id) })
  ipcMain.handle('version:name', (e, id: string, name: string) => { trusted(e); library.store.snapshot(id, name) })
  ipcMain.handle('version:restore', (e, id: string, v: string) => { trusted(e); return library.store.restore(id, v) })
  ipcMain.handle('version:delete', (e, id: string, v: string) => { trusted(e); library.store.deleteVersion(id, v) })
}

async function openWindow() {
  window = new BrowserWindow({
    title: 'Tinto', width: 1240, height: 840, minWidth: 740, minHeight: 520, show: false,
    backgroundColor: '#FCFAF6', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } } : {}),
    ...(process.platform === 'linux' ? { icon: join(__dirname, 'Tinto.png'), autoHideMenuBar: true } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== 'about:blank' || frameName !== 'tinto-history') return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { minWidth: 580, minHeight: 360, autoHideMenuBar: true } }
  })
  window.webContents.on('did-create-window', child => {
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', event => event.preventDefault())
  })
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

function showWindow() {
  if (!window) return void openWindow()
  if (window.isMinimized()) window.restore()
  window.show()
}

if (primaryWindow) app.whenReady().then(async () => {
  writing = new WritingService(__dirname)
  ipcMain.handle('writing:check', (event, request: unknown) => { trusted(event); return writing.check(request) })
  fonts = new FontLibrary(join(app.getPath('userData'), 'fonts'))
  protocol.handle('tinto', async request => {
    const url = new URL(request.url)
    const path = url.pathname.slice(1)
    // Manuscript fonts the writer added, by the content name Tinto gave them.
    const font = url.host === 'app' && /^fonts\/([0-9a-f]{32}\.(ttf|otf|woff|woff2))$/.exec(path)
    if (font) {
      const bytes = await fonts.bytes(font[1])
      return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': FONT_TYPES[font[2]], 'Cache-Control': 'max-age=31536000, immutable' } }) : new Response(null, { status: 404 })
    }
    const mime: Record<string, string> = { html: 'text/html', css: 'text/css', js: 'application/javascript', mjs: 'application/javascript' }
    if (url.host !== 'app' || !/^(index\.html|app\.js|pdf(?:\.worker)?\.mjs|(?:styles|spelling|draft)\.css)$/.test(path)) return new Response(null, { status: 404 })
    const bytes = await readFile(join(__dirname, path))
    return new Response(bytes, { headers: { 'Content-Type': mime[extname(path).slice(1)] + '; charset=utf-8' } })
  })
  library = new ProjectLibrary(join(app.getPath('userData'), 'projects.json'))
  const updateBackupPath = registerBackups({ window: () => window!, project: () => library.activeProject, open: path => library.open(path), trusted })
  const publishing = registerPublishing({ window: () => window!, project: () => library.activeProject, trusted })
  registerTranslation({ trusted })
  registerUpdates({ trusted })
  registerProjectActions(updateBackupPath, publishing.idle)
  registerFonts({ window: () => window!, trusted }, fonts)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  app.on('activate', showWindow)
  app.on('second-instance', showWindow)
  await openWindow()
  const timer = setInterval(() => {
    try { library.tick() }
    catch (error) { dialog.showErrorBox('Tinto could not save a history snapshot', String(error)) }
  }, 30_000)
  timer.unref()
}).catch(error => { dialog.showErrorBox('Tinto could not open the project', String(error)); app.quit() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { writing?.stop(); library?.close() })
