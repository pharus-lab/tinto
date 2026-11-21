import { contextBridge, ipcRenderer } from 'electron'
import type { Desktop } from './desktop'

const desktop: Desktop = {
  platform: process.platform,
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  connectDrive: () => ipcRenderer.invoke('backup:connect'),
  disconnectDrive: () => ipcRenderer.invoke('backup:disconnect'),
  enableBackup: enabled => ipcRenderer.invoke('backup:enable', enabled),
  backUp: () => ipcRenderer.invoke('backup:now'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  openRestored: path => ipcRenderer.invoke('backup:open-restored', path),
  restoreBackup: id => ipcRenderer.invoke('backup:restore', id),
  online: () => ipcRenderer.invoke('backup:online'),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  exportFile: (format, title, doc) => ipcRenderer.invoke('file:export', format, title, doc),
  createDraft: (id, headingId, title) => ipcRenderer.invoke('draft:create', id, headingId, title),
  reviewDraft: id => ipcRenderer.invoke('draft:review', id),
  applyDraft: (id, resolutions) => ipcRenderer.invoke('draft:apply', id, resolutions),
  listPacks: () => ipcRenderer.invoke('packs:list'),
  readPack: code => ipcRenderer.invoke('packs:read', code),
  installPack: code => ipcRenderer.invoke('packs:install', code),
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
  save: (path, projectId, document) => ipcRenderer.sendSync('document:save', path, projectId, document),
  versions: id => ipcRenderer.invoke('version:list', id),
  nameVersion: (id, name) => ipcRenderer.invoke('version:name', id, name),
  restore: (id, version) => ipcRenderer.invoke('version:restore', id, version),
  deleteVersion: (id, version) => ipcRenderer.invoke('version:delete', id, version)
}
contextBridge.exposeInMainWorld('tinto', desktop)
