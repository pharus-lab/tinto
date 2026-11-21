import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CloudflareSite, validateConfig, verifySite, type SiteConfig } from './cloudflare'
import { Publisher, type ImageInput } from './publishing'
import { protect, reveal } from './secure-file'
import { ProjectStore } from './storage'
import type { PickedImage, PostImageChoice, PublishRequest, SiteStatus } from './project-types'

interface PublishContext {
  window(): BrowserWindow
  project(): { id: string; path: string } | null
  trusted(event: Electron.IpcMainInvokeEvent): void
}

export function registerPublishing(context: PublishContext) {
  const file = join(app.getPath('userData'), 'site-connection.enc')
  const purpose = 'connect a Cloudflare site'
  let config: SiteConfig | null = null
  async function connection(): Promise<SiteConfig> {
    if (config) return config
    if (!existsSync(file)) throw Error('Connect a Cloudflare site in Settings first.')
    config = validateConfig(JSON.parse(await reveal(file, purpose)))
    return config
  }
  const publisher = new Publisher(async () => new CloudflareSite(await connection()))
  // The renderer refers to chosen images by token; it never supplies a path.
  const picked = new Map<string, { path: string; name: string }>()

  async function status(): Promise<SiteStatus> {
    if (!existsSync(file)) return { connected: false, accountId: null, databaseId: null, bucket: null, error: null }
    try {
      const { accountId, databaseId, bucket } = await connection()
      return { connected: true, accountId, databaseId, bucket, error: null }
    } catch (error) {
      return { connected: true, accountId: null, databaseId: null, bucket: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  // A temporary connection keeps a slow upload independent of project navigation.
  async function withProject<T>(task: (store: ProjectStore) => Promise<T>): Promise<T> {
    const active = context.project()
    if (!active) throw Error('Open a project first.')
    const store = new ProjectStore(active.path)
    try { return await task(store) } finally { store.close() }
  }
  function image(choice: PostImageChoice): ImageInput {
    if ('key' in choice) return { alt: choice.alt, key: String(choice.key) }
    const file = picked.get(choice.token)
    if (!file) throw Error('Choose the image again.')
    return { alt: choice.alt, ...file }
  }

  ipcMain.handle('site:status', event => { context.trusted(event); return status() })
  ipcMain.handle('site:connect', async (event, input: SiteConfig) => {
    context.trusted(event)
    const next = validateConfig(input)
    await verifySite(new CloudflareSite(next))
    await publisher.idle()
    await protect(file, JSON.stringify(next), purpose)
    config = next
    return status()
  })
  ipcMain.handle('site:test', async event => {
    context.trusted(event)
    await verifySite(new CloudflareSite(await connection()))
    return status()
  })
  ipcMain.handle('site:disconnect', async event => {
    context.trusted(event)
    await publisher.idle()
    await rm(file, { force: true })
    config = null
    return status()
  })
  ipcMain.handle('post:load', (event, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(async store => store.post(documentId, headingId))
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
    const input = { documentId: request.documentId, headingId: request.headingId, fields: request.fields, cover: request.cover ? image(request.cover) : null, images: request.images.map(image) }
    const result = await withProject(store => publisher.publish(store, input))
    for (const choice of choices) if ('token' in choice) picked.delete(choice.token)
    return result
  })
  ipcMain.handle('post:unpublish', (event, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(store => publisher.unpublish(store, documentId, headingId))
  })
  ipcMain.handle('post:rebuild', (event, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(store => publisher.rebuild(store, documentId, headingId))
  })
}
