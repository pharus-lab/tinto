import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DriveAuth } from './drive-auth'
import { DriveBackups, GoogleDrive } from './drive'
import { ProjectStore } from './storage'
import type { Workspace } from './project-types'

interface BackupContext {
  window(): BrowserWindow
  project(): { id: string; path: string }
  open(path: string): Workspace
  trusted(event: Electron.IpcMainInvokeEvent): void
}
export interface BackupStatus { connected: boolean; enabled: boolean; lastSuccess: number | null; error: string | null }
export function registerBackups(context: BackupContext) {
  const directory = app.getPath('userData')
  const auth = new DriveAuth(directory)
  const backups = new DriveBackups(directory, new GoogleDrive(() => auth.token()))
  const choicesFile = join(directory, 'backup-projects.json')
  let optedIn: string[] = existsSync(choicesFile) ? JSON.parse(readFileSync(choicesFile, 'utf8')) : []
  function saveChoices(next: string[]) {
    writeFileSync(choicesFile + '.tmp', JSON.stringify(next), { mode: 0o600 })
    renameSync(choicesFile + '.tmp', choicesFile)
    optedIn = next
  }
  function enable(path: string, enabled: boolean) {
    const next = optedIn.filter(item => item !== path)
    if (enabled) next.push(path)
    saveChoices(next)
  }
  let error: string | null = null
  let running: Promise<void> | null = null
  function status(): BackupStatus {
    return { connected: auth.connected, enabled: optedIn.includes(context.project().path), lastSuccess: backups.lastSuccess(context.project().id), error }
  }
  async function run(automatic: boolean) {
    if (!auth.connected) return
    if (running) {
      if (automatic) return
      await running.catch(() => {})
    }
    if (!auth.connected) return
    const active = context.project()
    // A temporary read connection keeps a background upload independent of tab
    // and project navigation. Previously opened projects can finish pending work.
    const paths = automatic ? [...optedIn] : [active.path]
    running = (async () => {
      const failures: string[] = []
      for (const path of paths) {
        if (!auth.connected || !existsSync(path)) continue
        let snapshot: ProjectStore | undefined
        try {
          snapshot = new ProjectStore(path)
          await backups.backup(snapshot, automatic)
        } catch (problem) { failures.push(basename(path) + ' — ' + String(problem)) }
        finally { snapshot?.close() }
      }
      if (failures.length) throw Error(failures.join('\n'))
    })()
    try { await running; error = null }
    catch (problem) { error = problem instanceof Error ? problem.message : String(problem); if (!automatic) throw problem }
    finally { running = null }
  }
  ipcMain.handle('backup:status', event => { context.trusted(event); return status() })
  ipcMain.handle('backup:connect', async event => {
    context.trusted(event)
    let credentials: string | undefined
    if (!auth.configured) {
      const result = await dialog.showOpenDialog(context.window(), { title: 'Choose Google desktop OAuth client credentials', filters: [{ name: 'Desktop client JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (result.canceled) return status()
      credentials = result.filePaths[0]
    }
    const path = context.project().path
    await auth.connect(credentials)
    enable(path, true)
    void run(true)
    return status()
  })
  ipcMain.handle('backup:enable', (event, enabled: boolean) => {
    context.trusted(event)
    enable(context.project().path, enabled)
    if (enabled) void run(true)
    return status()
  })
  ipcMain.handle('backup:disconnect', async event => {
    context.trusted(event)
    await running?.catch(() => {})
    await auth.disconnect()
    backups.resetLocalState()
    saveChoices([])
    error = null
    return status()
  })
  ipcMain.handle('backup:now', async event => { context.trusted(event); await run(false); return status() })
  ipcMain.handle('backup:list', event => { context.trusted(event); return backups.list() })
  ipcMain.handle('backup:online', event => { context.trusted(event); if (error) void run(true) })
  let restoredPath: string | null = null
  ipcMain.handle('backup:restore', async (event, id: string) => {
    context.trusted(event)
    const selected = await dialog.showSaveDialog(context.window(), { title: 'Restore backup to a new project file', defaultPath: 'Restored project.tinto', filters: [{ name: 'Tinto project', extensions: ['tinto'] }] })
    if (selected.canceled || !selected.filePath) return null
    await backups.restore(id, selected.filePath)
    restoredPath = selected.filePath
    return selected.filePath
  })
  ipcMain.handle('backup:open-restored', (event, path: string) => {
    context.trusted(event)
    if (path !== restoredPath) throw Error('Open this project from Home.')
    const next = context.open(path)
    restoredPath = null
    return next
  })
  const timer = setInterval(() => void run(true), 15 * 60_000)
  timer.unref()
  if (auth.connected) void run(true)
}
