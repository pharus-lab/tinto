import { contextBridge, ipcRenderer } from 'electron'
import type { Desktop } from './desktop'

const desktop: Desktop = {
  checkWriting: request => ipcRenderer.invoke('writing:check', request),
  platform: process.platform,
  experimental: ipcRenderer.sendSync('app:experimental') === true,
  version: String(ipcRenderer.sendSync('app:version')),
  updateInterval: Number(ipcRenderer.sendSync('app:update-interval')),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),
  openRelease: () => ipcRenderer.invoke('updates:open'),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  connectDrive: () => ipcRenderer.invoke('backup:connect'),
  disconnectDrive: () => ipcRenderer.invoke('backup:disconnect'),
  enableBackup: enabled => ipcRenderer.invoke('backup:enable', enabled),
  backUp: () => ipcRenderer.invoke('backup:now'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  openRestored: path => ipcRenderer.invoke('backup:open-restored', path),
  restoreBackup: id => ipcRenderer.invoke('backup:restore', id),
  online: () => ipcRenderer.invoke('backup:online'),
  author: () => ipcRenderer.invoke('author:get'),
  createAuthor: name => ipcRenderer.invoke('author:create', name),
  renameAuthor: name => ipcRenderer.invoke('author:rename', name),
  exportAuthor: passphrase => ipcRenderer.invoke('author:export', passphrase),
  importAuthor: passphrase => ipcRenderer.invoke('author:import', passphrase),
  authorship: (documentId, headingId) => ipcRenderer.invoke('authorship:preview', documentId, headingId),
  // Synchronous, like saving, so writing measured just before the window closes is kept.
  recordWriting: (path, projectId, documentId, kind, sample) => { ipcRenderer.sendSync('authorship:record', path, projectId, documentId, kind, sample) },
  fonts: () => ipcRenderer.invoke('fonts:list'),
  addFonts: characters => ipcRenderer.invoke('fonts:add', characters),
  checkFont: (id, characters) => ipcRenderer.invoke('fonts:check', id, characters),
  removeFont: id => ipcRenderer.invoke('fonts:remove', id),
  sites: () => ipcRenderer.invoke('sites:list'),
  addSite: (endpoint, key) => ipcRenderer.invoke('sites:add', endpoint, key),
  testSite: id => ipcRenderer.invoke('sites:test', id),
  removeSite: id => ipcRenderer.invoke('sites:remove', id),
  posts: (documentId, headingId) => ipcRenderer.invoke('post:list', documentId, headingId),
  saveModule: values => ipcRenderer.invoke('guide:save-module', values),
  copyText: text => ipcRenderer.invoke('guide:copy', text),
  openCloudflare: () => ipcRenderer.invoke('guide:open-dashboard'),
  allPosts: () => ipcRenderer.invoke('post:all'),
  pickFiles: kind => ipcRenderer.invoke('post:pick-files', kind),
  publishPost: request => ipcRenderer.invoke('post:publish', request),
  previewPost: request => ipcRenderer.invoke('post:preview', request),
  onPublishProgress: listener => {
    const forward = (_event: Electron.IpcRendererEvent, done: number, total: number) => listener(done, total)
    ipcRenderer.on('post:progress', forward)
    return () => { ipcRenderer.removeListener('post:progress', forward) }
  },
  translatorStatus: () => ipcRenderer.invoke('translator:status'),
  saveTranslator: (provider, key, model) => ipcRenderer.invoke('translator:save', provider, key, model),
  testTranslator: () => ipcRenderer.invoke('translator:test'),
  removeTranslator: () => ipcRenderer.invoke('translator:remove'),
  translate: (source, from, to) => ipcRenderer.invoke('translator:translate', source, from, to),
  translateTexts: (texts, from, to) => ipcRenderer.invoke('translator:texts', texts, from, to),
  coachWriting: request => ipcRenderer.invoke('coach:review', request),
  aiUsage: () => ipcRenderer.invoke('ai-usage:get'),
  resetAiUsage: () => ipcRenderer.invoke('ai-usage:reset'),
  onCoachProgress: listener => {
    const forward = (_event: Electron.IpcRendererEvent, done: number, total: number) => listener(done, total)
    ipcRenderer.on('coach:progress', forward)
    return () => { ipcRenderer.removeListener('coach:progress', forward) }
  },
  onTranslateProgress: listener => {
    const forward = (_event: Electron.IpcRendererEvent, done: number, total: number) => listener(done, total)
    ipcRenderer.on('translator:progress', forward)
    return () => { ipcRenderer.removeListener('translator:progress', forward) }
  },
  unpublishPost: (siteId, documentId, headingId) => ipcRenderer.invoke('post:unpublish', siteId, documentId, headingId),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  exportFile: (format, title, doc, language, font) => ipcRenderer.invoke('file:export', format, title, doc, language, font),
  createDraft: (id, headingId, title) => ipcRenderer.invoke('draft:create', id, headingId, title),
  reviewDraft: id => ipcRenderer.invoke('draft:review', id),
  applyDraft: (id, resolutions) => ipcRenderer.invoke('draft:apply', id, resolutions),
  library: () => ipcRenderer.invoke('library'),
  chooseFolder: folder => ipcRenderer.invoke('library:choose', folder),
  newFolder: () => ipcRenderer.invoke('library:create'),
  sample: () => ipcRenderer.invoke('project:sample'),
  workspace: () => ipcRenderer.invoke('workspace'),
  open: item => ipcRenderer.invoke('project:open', item),
  create: () => ipcRenderer.invoke('project:create'),
  renameProject: (path, title) => ipcRenderer.invoke('project:rename', path, title),
  deleteProject: path => ipcRenderer.invoke('project:delete', path),
  deleteDocument: (path, id) => ipcRenderer.invoke('document:delete', path, id),
  moveDocument: (source, id, destination) => ipcRenderer.invoke('document:move', source, id, destination),
  undoMove: () => ipcRenderer.invoke('document:undo-move'),
  save: (path, projectId, document) => ipcRenderer.sendSync('document:save', path, projectId, document),
  versions: id => ipcRenderer.invoke('version:list', id),
  nameVersion: (id, name) => ipcRenderer.invoke('version:name', id, name),
  restore: (id, version) => ipcRenderer.invoke('version:restore', id, version),
  deleteVersion: (id, version) => ipcRenderer.invoke('version:delete', id, version)
}
contextBridge.exposeInMainWorld('tinto', desktop)
