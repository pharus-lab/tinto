import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))

export async function desktopFixture(t) {
  const executablePath = process.env.TINTO_PACKAGED_EXECUTABLE
  if (!executablePath) await import('../scripts/build.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'tinto-desktop-'))
  const profile = join(directory, 'profile')
  const folder = join(directory, 'Manuscripts')
  await mkdir(folder)
  let app
  let sampleOpened = false
  t.after(async () => {
    if (app) await app.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function launch() {
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: root, env: { ...process.env, TINTO_USER_DATA: profile, TINTO_RELEASES_URL: process.env.TINTO_RELEASES_URL ?? 'http://127.0.0.1:9/releases/latest' } })
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await page.waitForURL('tinto://app/index.html')
    return page
  }
  async function open() {
    const page = await launch()
    if (!sampleOpened) {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, folder)
      await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
      await page.getByRole('button', { name: 'Open sample project', exact: true }).click()
      sampleOpened = true
    }
    await page.locator('.ProseMirror:visible').waitFor()
    return page
  }
  async function close() {
    await app.close()
    app = undefined
  }
  return { open, launch, close, directory, profile, folder, get app() { return app } }
}
