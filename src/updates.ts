import { app, ipcMain, shell } from 'electron'

// When Tinto opens, and then once a day while it stays open, it asks GitHub for
// the latest release and says so when there is a newer version. Nothing from the
// writer's projects is sent, and the writer can turn the check off in
// Settings → About. GitHub follows the repository if it moves to another owner.
const REPOSITORY = 'pharus-lab/tinto'
const LATEST = process.env.TINTO_RELEASES_URL || 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest'
export interface Release { version: string; url: string }
// A day between checks; tests shorten it with TINTO_UPDATE_INTERVAL_MS.
const DAY = 24 * 60 * 60 * 1000
const INTERVAL = Math.max(1000, Number(process.env.TINTO_UPDATE_INTERVAL_MS) || DAY)

// Whether a version (1.2.3) is newer than another.
export function newer(candidate: string, current: string): boolean {
  const parts = (version: string) => version.replace(/^v/, '').split('.').map(part => parseInt(part, 10) || 0)
  const [a, b] = [parts(candidate), parts(current)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

export async function latestRelease(current: string, fetcher: typeof fetch = globalThis.fetch): Promise<Release | null> {
  try {
    const response = await fetcher(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tinto/' + current }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const body = await response.json() as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
    const version = String(body?.tag_name ?? '').replace(/^v/, '')
    const url = String(body?.html_url ?? '')
    if (body?.draft || body?.prerelease || !/^\d+\.\d+\.\d+$/.test(version) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(url)) return null
    return newer(version, current) ? { version, url } : null
  } catch {
    // Offline, a private repository or a slow answer: no notice, no error.
    return null
  }
}

export function registerUpdates(context: { trusted(event: Electron.IpcMainInvokeEvent): void }) {
  let found: Release | null = null
  ipcMain.on('app:version', event => { event.returnValue = app.getVersion() })
  ipcMain.on('app:update-interval', event => { event.returnValue = INTERVAL })
  ipcMain.handle('updates:check', async event => {
    context.trusted(event)
    found = await latestRelease(app.getVersion())
    return found
  })
  // Only the release page GitHub returned opens, in the writer's browser.
  ipcMain.handle('updates:open', async event => {
    context.trusted(event)
    if (found) await shell.openExternal(found.url)
  })
}
