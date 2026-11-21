import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AuthorKeys } from './author'
import { characterTotals } from './authorship'
import { writeModule, checkModuleSite, type ModuleSite } from './module-export'
import { FILE_TYPES } from '../modules/cloudflare/files.mjs'
import { Publisher, bodyBlocks, changedSinceRelease, type AttachmentInput, type ImageInput } from './publishing'
import { protect, reveal } from './secure-file'
import { SiteClient, siteId, validateConnection, type SiteConnection } from './site-api'
import { ProjectStore } from './storage'
import type { AuthorshipPreview, FilePick, PickedFile, PostAttachmentChoice, PostImageChoice, PostOverview, PublishRequest, SiteCategory, SiteSummary } from './project-types'

interface PublishContext {
  window(): BrowserWindow
  project(): { id: string; path: string } | null
  trusted(event: Electron.IpcMainInvokeEvent): void
}
interface SavedSite extends SiteConnection { id: string; name: string; categories?: SiteCategory[] }
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
  const summary = ({ id, name, endpoint, categories }: SavedSite): SiteSummary => ({ id, name, endpoint, categories: categories ?? [] })
  // One author key per installation signs every post.
  const author = new AuthorKeys(join(app.getPath('userData'), 'author.enc'))
  const publisher = new Publisher(async id => new SiteClient(await site(id)), () => author.signer())
  // The renderer refers to chosen images by token; it never supplies a path.
  const picked = new Map<string, { path: string; name: string }>()

  // A temporary connection keeps a slow upload independent of project navigation.
  async function withProject<T>(task: (store: ProjectStore) => Promise<T>): Promise<T> {
    const active = context.project()
    if (!active) throw Error('Open a project first.')
    const store = new ProjectStore(active.path)
    try { return await task(store) } finally { store.close() }
  }
  function chosen(token: string) {
    const file = picked.get(token)
    if (!file) throw Error('Choose the file again.')
    return file
  }
  function image(choice: PostImageChoice): ImageInput {
    return 'file' in choice ? { alt: choice.alt, file: String(choice.file) } : { alt: choice.alt, ...chosen(choice.token) }
  }
  function attachment(choice: PostAttachmentChoice): AttachmentInput {
    return 'file' in choice ? { title: choice.title, file: String(choice.file) } : { title: choice.title, ...chosen(choice.token) }
  }

  ipcMain.handle('author:get', event => { context.trusted(event); return author.summary() })
  ipcMain.handle('author:create', async (event, name: string) => { context.trusted(event); await publisher.idle(); return author.create(name) })
  ipcMain.handle('author:rename', async (event, name: string) => { context.trusted(event); await publisher.idle(); return author.rename(name) })
  // The export is encrypted with the writer's passphrase, for their other computers.
  ipcMain.handle('author:export', async (event, passphrase: string) => {
    context.trusted(event)
    const current = await author.summary()
    if (!current) throw Error('Create your author key first.')
    const bytes = await author.exportKey(passphrase)
    const choice = await dialog.showSaveDialog(context.window(), {
      title: 'Export your author key', buttonLabel: 'Export key', defaultPath: join(app.getPath('documents'), current.name + ' author key.tintokey'),
      filters: [{ name: 'Tinto author key', extensions: ['tintokey'] }]
    })
    if (choice.canceled || !choice.filePath) return null
    await writeFile(choice.filePath, bytes, { mode: 0o600 })
    return choice.filePath
  })
  ipcMain.handle('author:import', async (event, passphrase: string) => {
    context.trusted(event)
    const window = context.window()
    const choice = await dialog.showOpenDialog(window, {
      title: 'Import an author key', buttonLabel: 'Import key', properties: ['openFile'], filters: [{ name: 'Tinto author key', extensions: ['tintokey'] }]
    })
    const path = choice.filePaths[0]
    if (choice.canceled || !path) return null
    const imported = await author.readExport(new Uint8Array(await readFile(path)), passphrase)
    const current = await author.summary()
    if (current && current.did !== imported.did) {
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', buttons: ['Cancel', 'Replace key'], defaultId: 0, cancelId: 0,
        message: 'Replace the author key on this computer?',
        detail: 'Websites that accept posts from your current key will refuse posts signed with the imported one until their owner changes the author in tinto.config.mjs. Export your current key first if you may need it again.'
      })
      if (answer.response !== 1) return null
    }
    await publisher.idle()
    return author.adopt(imported)
  })
  // What the Publish dialog shows before signing: who signs, and where the text came from.
  ipcMain.handle('authorship:preview', async (event, documentId: string, headingId: string | null): Promise<AuthorshipPreview> => {
    context.trusted(event)
    const signer = await author.summary()
    return withProject(async store => {
      const evidence = store.writingEvidence(documentId)
      return {
        author: signer, characters: characterTotals(bodyBlocks(store.readDocument(documentId), headingId)),
        typed: evidence.typed, activeMinutes: Math.round(evidence.activeMs / 60_000), intact: evidence.intact
      }
    })
  })
  ipcMain.handle('sites:list', async event => {
    context.trusted(event)
    return (await sites()).map(summary)
  })
  // Adding a publishing URL that is already listed replaces its key.
  ipcMain.handle('sites:add', async (event, endpoint: string, key: string) => {
    context.trusted(event)
    const connection = validateConnection({ endpoint, key })
    const { name, categories } = await new SiteClient(connection).info()
    const entry: SavedSite = { id: siteId(connection.endpoint), name, categories, ...connection }
    await publisher.idle()
    const current = await sites()
    await keep(current.some(item => item.id === entry.id) ? current.map(item => item.id === entry.id ? entry : item) : [...current, entry])
    return summary(entry)
  })
  ipcMain.handle('sites:test', async (event, id: string) => {
    context.trusted(event)
    const entry = await site(id)
    const { name, categories } = await new SiteClient(entry).info()
    await keep((await sites()).map(item => item.id === id ? { ...item, name, categories } : item))
    return summary({ ...entry, name, categories })
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
    return writeModule(folder, join(__dirname, 'cloudflare-module'), { ...site, author: (await author.summary())?.did ?? null })
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
    return withProject(async store => store.posts(documentId, headingId).map(post => ({ ...post, changed: changedSinceRelease(store, post) })))
  })
  // Every post in the project, with its document and website, for the Posts overview.
  ipcMain.handle('post:all', async event => {
    context.trusted(event)
    const names = new Map((await sites()).map(item => [item.id, item.name]))
    return withProject(async store => {
      const titles = new Map(store.read().documents.map(doc => [doc.id, doc.title]))
      return store.allPosts().map((post): PostOverview => ({
        ...post, changed: changedSinceRelease(store, post), documentTitle: titles.get(post.documentId) ?? '', siteName: names.get(post.siteId) ?? null
      }))
    })
  })
  ipcMain.handle('post:pick-files', async (event, kind: FilePick): Promise<PickedFile[]> => {
    context.trusted(event)
    const images = Object.keys(FILE_TYPES).filter(ext => FILE_TYPES[ext].class === 'images')
    const others = Object.keys(FILE_TYPES).filter(ext => FILE_TYPES[ext].class !== 'images')
    const options = {
      cover: { title: 'Choose a cover image', buttonLabel: 'Choose image', multiple: false, filter: { name: 'Images', extensions: [...images, 'jpeg'] } },
      gallery: { title: 'Add images to the post', buttonLabel: 'Add images', multiple: true, filter: { name: 'Images', extensions: [...images, 'jpeg'] } },
      attachments: { title: 'Attach files to the post', buttonLabel: 'Attach', multiple: true, filter: { name: 'Documents, audio, video and downloads', extensions: others } }
    }[kind]
    if (!options) throw Error('Choose the kind of file first.')
    const result = await dialog.showOpenDialog(context.window(), {
      title: options.title, buttonLabel: options.buttonLabel,
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: [options.filter]
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async path => {
      const token = randomUUID()
      const name = basename(path)
      picked.set(token, { path, name })
      return { token, name, size: (await stat(path)).size }
    }))
  })
  async function publishInput(request: PublishRequest) {
    const target = await site(String(request.siteId))
    return {
      target,
      input: {
        siteId: target.id, siteName: target.name, documentId: request.documentId, headingId: request.headingId,
        status: request.status === 'draft' ? 'draft' as const : 'published' as const, fields: request.fields,
        cover: request.cover ? image(request.cover) : null, images: request.images.map(image), attachments: request.attachments.map(attachment)
      }
    }
  }
  // Upload progress goes to the window that asked, as files finish.
  const progressTo = (event: Electron.IpcMainInvokeEvent) => (done: number, total: number) => {
    if (!event.sender.isDestroyed()) event.sender.send('post:progress', done, total)
  }
  ipcMain.handle('post:publish', async (event, request: PublishRequest) => {
    context.trusted(event)
    const choices = [...(request.cover ? [request.cover] : []), ...request.images, ...request.attachments]
    const { input } = await publishInput(request)
    const post = await withProject(store => publisher.publish(store, input, progressTo(event)))
    for (const choice of choices) if ('token' in choice) picked.delete(choice.token)
    return { ...post, changed: false }
  })
  // The preview opens in the writer's browser, only on the website's own origin.
  ipcMain.handle('post:preview', async (event, request: PublishRequest) => {
    context.trusted(event)
    const { target, input } = await publishInput(request)
    const url = await withProject(store => publisher.preview(store, input, progressTo(event)))
    if (new URL(url).origin !== new URL(target.endpoint).origin) throw Error('The website returned a preview address on another site.')
    await shell.openExternal(url)
    return url
  })
  ipcMain.handle('post:unpublish', (event, siteId: string, documentId: string, headingId: string | null) => {
    context.trusted(event)
    return withProject(store => publisher.unpublish(store, siteId, documentId, headingId))
  })
  // Moving or deleting a document waits for publications in progress, so their
  // records reach the project before the document leaves it.
  return { idle: () => publisher.idle() }
}
