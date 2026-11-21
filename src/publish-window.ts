import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeModule, checkModuleSite, type ModuleSite } from './module-export'
import { Publisher, type ImageInput } from './publishing'
import { protect, reveal } from './secure-file'
import { SiteClient, siteId, validateConnection, type SiteConnection } from './site-api'
import { ProjectStore } from './storage'
import type { PickedImage, PostImageChoice, PublishRequest, SiteSummary } from './project-types'

interface PublishContext {
  window(): BrowserWindow
  project(): { id: string; path: string } | null
  trusted(event: Electron.IpcMainInvokeEvent): void
}
interface SavedSite extends SiteConnection { id: string; name: string }
// The guide opens only this address, so the renderer never chooses a URL.
const WORKERS_DASHBOARD = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages'
const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']

export function registerPublishing(context: PublishContext) {
  // Every website's publishing URL and API key, encrypted together.
  const file = join(app.getPath('userData'), 'sites.enc')
  const purpose = 'publish to your websites'
  let saved: SavedSite[] | null = null
  async function sites(): Promise<SavedSite[]> {
    saved ??= existsSync(file) ? JSON.parse(await reveal(file, purpose)) as SavedSite[] : []
    return saved
  }
  async function keep(next: SavedSite[]) {
    if (next.length) await protect(file, JSON.stringify(next), purpose)
    else await rm(file, { force: true })
    saved = next
  }
  async function site(id: string): Promise<SavedSite> {
    const found = (await sites()).find(item => item.id === id)
    if (!found) throw Error('This website is no longer in Tinto. Add it again in Settings.')
    return found
  }
  const summary = ({ id, name, endpoint }: SavedSite): SiteSummary => ({ id, name, endpoint })
  const publisher = new Publisher(async id => new SiteClient(await site(id)))
  // The renderer refers to chosen images by token; it never supplies a path.
  const picked = new Map<string, { path: string; name: string }>()

  // A temporary connection keeps a slow upload independent of project navigation.
  async function withProject<T>(task: (store: ProjectStore) => Promise<T>): Promise<T> {
    const active = context.project()
    if (!active) throw Error('Open a project first.')
    const store = new ProjectStore(active.path)
    try { return await task(store) } finally { store.close() }
  }
  function image(choice: PostImageChoice): ImageInput {
    if ('file' in choice) return { alt: choice.alt, file: String(choice.file) }
    const file = picked.get(choice.token)
    if (!file) throw Error('Choose the image again.')
    return { alt: choice.alt, ...file }
  }

  ipcMain.handle('sites:list', async event => {
    context.trusted(event)
    return (await sites()).map(summary)
  })
  // Adding a publishing URL that is already listed replaces its key.
  ipcMain.handle('sites:add', async (event, endpoint: string, key: string) => {
    context.trusted(event)
    const connection = validateConnection({ endpoint, key })
    const { name } = await new SiteClient(connection).info()
    const entry: SavedSite = { id: siteId(connection.endpoint), name, ...connection }
    await publisher.idle()
    const current = await sites()
    await keep(current.some(item => item.id === entry.id) ? current.map(item => item.id === entry.id ? entry : item) : [...current, entry])
    return summary(entry)
  })
  ipcMain.handle('sites:test', async (event, id: string) => {
    context.trusted(event)
    const entry = await site(id)
    const { name } = await new SiteClient(entry).info()
    if (name !== entry.name) await keep((await sites()).map(item => item.id === id ? { ...item, name } : item))
    return summary({ ...entry, name })
  })
  ipcMain.handle('sites:remove', async (event, id: string) => {
    context.trusted(event)
    await publisher.idle()
    await keep((await sites()).filter(item => item.id !== id))
  })
  // Connect-a-website guide: writes the bundled module into the folder the writer picks.
  ipcMain.handle('guide:save-module', async (event, values: ModuleSite) => {
    context.trusted(event)
    const site = checkModuleSite(values)
    const window = context.window()
    const choice = await dialog.showOpenDialog(window, {
      title: 'Choose your website’s project folder', buttonLabel: 'Add module here', properties: ['openDirectory', 'createDirectory']
    })
    const folder = choice.filePaths[0]
    if (choice.canceled || !folder) return null
    const ask = async (message: string, detail: string, action: string) =>
      (await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', action], defaultId: 1, cancelId: 0, message, detail })).response === 1
    if (!WRANGLER_FILES.some(file => existsSync(join(folder, file)))
      && !await ask('This folder has no Wrangler configuration.', 'Choose the project folder of a website that deploys to Cloudflare Workers. It contains wrangler.jsonc, wrangler.json or wrangler.toml.', 'Add module anyway')) return null
    if (existsSync(join(folder, 'tinto'))
      && !await ask('This website already has a tinto folder.', 'Tinto replaces the module code and keeps tinto.config.mjs with your settings.', 'Update module files')) return null
    return writeModule(folder, join(__dirname, 'cloudflare-module'), site)
  })
  ipcMain.handle('guide:copy', (event, text: string) => {
    context.trusted(event)
    clipboard.writeText(String(text).slice(0, 20_000))
  })
  ipcMain.handle('guide:open-dashboard', event => {
    context.trusted(event)
    return shell.openExternal(WORKERS_DASHBOARD)
  })
  ipcMain.handle('post:list', (event, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(async store => store.posts(documentId, headingId))
  })
  ipcMain.handle('post:pick-images', async (event, multiple: boolean): Promise<PickedImage[]> => {
    context.trusted(event)
    const result = await dialog.showOpenDialog(context.window(), {
      title: multiple ? 'Add images to the post' : 'Choose a cover image', buttonLabel: multiple ? 'Add images' : 'Choose image',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async path => {
      const token = randomUUID()
      const name = basename(path)
      picked.set(token, { path, name })
      return { token, name, size: (await stat(path)).size }
    }))
  })
  ipcMain.handle('post:publish', async (event, request: PublishRequest) => {
    context.trusted(event)
    const choices = [...(request.cover ? [request.cover] : []), ...request.images]
    const input = {
      siteId: String(request.siteId), documentId: request.documentId, headingId: request.headingId, fields: request.fields,
      cover: request.cover ? image(request.cover) : null, images: request.images.map(image)
    }
    const post = await withProject(store => publisher.publish(store, input))
    for (const choice of choices) if ('token' in choice) picked.delete(choice.token)
    return post
  })
  ipcMain.handle('post:unpublish', (event, siteId: string, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(store => publisher.unpublish(store, siteId, documentId, headingId))
  })
}
