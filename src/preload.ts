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
  workspace: () => ipcRenderer.invoke('workspace'),
  open: recentIndex => ipcRenderer.invoke('project:open', recentIndex),
  create: language => ipcRenderer.invoke('project:create', language),
  save: (path, projectId, document) => ipcRenderer.sendSync('document:save', path, projectId, document),
  versions: id => ipcRenderer.invoke('version:list', id),
  nameVersion: (id, name) => ipcRenderer.invoke('version:name', id, name),
  restore: (id, version) => ipcRenderer.invoke('version:restore', id, version),
  deleteVersion: (id, version) => ipcRenderer.invoke('version:delete', id, version)
}
contextBridge.exposeInMainWorld('tinto', desktop)
