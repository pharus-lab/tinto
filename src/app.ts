import { redoDepth, undoDepth } from 'prosemirror-history'
import { backupSettings } from './backup-settings'
import { importFile, type ExportFormat } from './exchange'
import { WritingEditor, type Format } from './editor'
import { newBlock, SAMPLE_SENTENCE, sectionRange, visibleText } from './model'
import type { DocumentRecord, LibraryState, RecentProject, Workspace } from './project-types'
import type { DictionaryPack } from './dictionary-packs'
import './desktop'
import { loadSpelling, setSpellingLanguage, spellingPlugin } from './spelling'
import { renderAlternatives } from './alternatives'
import { showDraftReview, createDraftDialog } from './draft-ui'
import { homeItemDialog, renderHome, type HomeItem } from './home'
import { showHistory } from './history'
import { dialogHeader, applyPreferences, languageOptions, preferences, showSettings, updateSettingsPacks } from './settings'
import { $, button, element, icon } from './ui'

interface Tab { documentId: string; headingId: string | null; scroll: number; review: string | null }
interface Session { tabs: Tab[]; current: number; panel: boolean }
const api = window.tinto
const prefs = preferences()
const modal = $('modal') as HTMLDialogElement
const language = $('language') as HTMLSelectElement
const blockStyle = $('block-style') as HTMLSelectElement
const undoButton = $('undo') as HTMLButtonElement
const redoButton = $('redo') as HTMLButtonElement
const scroll = $('scroll')
const editors = new Map<string, WritingEditor>()
const pending = new Map<string, { projectId: string; path: string; doc: DocumentRecord }>()
let library: LibraryState = { folder: null, folders: [], projects: [], workspace: null }
let tabs: Tab[] = []
let current: Tab | null = null
let editor: WritingEditor | null = null
let panelOpen = true
let timer: ReturnType<typeof setTimeout>
let noticeTimer: ReturnType<typeof setTimeout>
let switching = 0
let inspecting = false
let packs: DictionaryPack[] = []

function record(id: string) { return library.workspace!.project.documents.find(doc => doc.id === id)! }
function activeDocument() { return current ? record(current.documentId) : null }
function notice(text: string, undo?: () => Promise<void>) {
  const banner = $('notice')
  banner.textContent = text
  banner.hidden = false
  clearTimeout(noticeTimer)
  function dismissLater() {
    clearTimeout(noticeTimer)
    if (undo && banner.matches(':hover, :focus-within')) return
    noticeTimer = setTimeout(() => { banner.hidden = true }, 7000)
  }
  banner.onpointerenter = undo ? () => clearTimeout(noticeTimer) : null
  banner.onpointerleave = undo ? dismissLater : null
  if (undo) {
    const action = button('Undo', () => void undo().catch(report), 'outline')
    action.onfocus = () => clearTimeout(noticeTimer)
    action.onblur = dismissLater
    banner.append(action)
  }
  dismissLater()
}
function report(error: unknown) { notice(error instanceof Error ? error.message : String(error)) }
function status(text: string, saved = false) {
  $('save-status').textContent = text
  if (saved) $('save-status').prepend(icon('check'))
}
function saveSession() {
  if (!library.workspace) return
  if (current) current.scroll = scroll.scrollTop
  localStorage.setItem('tabs:' + library.workspace.project.id, JSON.stringify({ tabs, current: current ? tabs.indexOf(current) : -1, panel: panelOpen }))
}
function flush(): boolean {
  clearTimeout(timer)
  for (const [key, entry] of pending) {
    const problem = api.save(entry.path, entry.projectId, entry.doc)
    if (problem) {
      status('Save failed')
      notice(problem)
      return false
    }
    pending.delete(key)
  }
  if (library.workspace) status('Saved locally', true)
  return true
}
function changed(doc: DocumentRecord) {
  const workspace = library.workspace
  if (!workspace) return
  pending.set(JSON.stringify([workspace.path, doc.id]), { projectId: workspace.project.id, path: workspace.path, doc })
  status('Saving…')
  clearTimeout(timer)
  timer = setTimeout(flush, 450)
}
function label(tab: Tab) {
  const doc = record(tab.documentId)
  if (!tab.headingId) return doc.source ? doc.title + ' · Draft' : doc.title
  const block = doc.manuscript.content.find(block => block.attrs.id === tab.headingId)
  return block ? visibleText(block) || 'Untitled heading' : 'Removed section'
}
function drawTabs() {
  const host = $('tabs')
  const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.tabKey : undefined
  function item(tab: Tab | null) {
    const key = tab ? tab.documentId + '/' + (tab.headingId ?? '') : 'home'
    const wrap = element('div', 'tab' + (tab === current ? ' current' : ''))
    const title = tab ? label(tab) : 'Home'
    const select = button('', () => void selectTab(tab).catch(report), '', !tab ? 'home' : tab.headingId ? 'link' : 'book')
    select.title = title
    select.dataset.tabKey = key
    select.append(element('span', 'tab-label', title))
    if (tab === current) select.setAttribute('aria-current', 'page')
    wrap.append(select)
    if (tab) {
      const close = button('', () => closeTab(tab), 'close-tab', 'close')
      close.dataset.tabKey = 'close:' + key
      close.setAttribute('aria-label', 'Close ' + title)
      wrap.append(close)
    }
    return wrap
  }
  host.replaceChildren(item(null), ...tabs.map(item))
  if (focused) {
    const next = host.querySelector<HTMLElement>('[data-tab-key="' + CSS.escape(focused) + '"]') ?? host.querySelector<HTMLElement>('[aria-current=page]')
    next?.focus({ preventScroll: true })
  }
}
function drawTrail() {
  const doc = activeDocument()
  const names = [doc ? doc.title : 'Projects']
  if (doc && current?.headingId) {
    const index = sectionRange(doc.manuscript, current.headingId).from
    const ancestors: string[] = []
    for (const block of doc.manuscript.content.slice(0, index + 1)) {
      if (block.type !== 'heading') continue
      const level = block.attrs.level ?? 1
      ancestors.length = level - 1
      ancestors[level - 1] = visibleText(block)
    }
    names.push(...ancestors.filter(Boolean))
  }
  if (doc && editor) {
    const headings = editor.view.dom.querySelectorAll<HTMLElement>(':is(h1,h2,h3,h4,h5,h6):not([aria-hidden])')
    const edge = scroll.getBoundingClientRect().top + 2
    const passed: string[] = []
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > edge) break
      passed.length = Number(heading.tagName.slice(1)) - 1
      passed.push(heading.textContent || 'Untitled heading')
    }
    if (current?.headingId && passed.length) {
      const level = doc.manuscript.content.find(b => b.attrs.id === current?.headingId)?.attrs.level ?? 1
      names.push(...passed.slice(level).filter(Boolean))
    } else names.push(...passed.filter(Boolean))
  }
  const trail = $('trail')
  trail.replaceChildren(icon(doc ? 'book' : 'folder'))
  names.forEach((name, index) => {
    if (index) { const separator = icon('chev'); separator.setAttribute('class','separator'); trail.append(separator) }
    trail.append(element('span', '', name))
  })
}
function drawCount() {
  const doc = activeDocument()
  if (!doc || !current) { $('word-count').textContent = ''; return }
  const range = current.headingId && sectionRange(doc.manuscript, current.headingId)
  const blocks = range ? doc.manuscript.content.slice(range.from, range.to) : doc.manuscript.content
  const count = blocks.reduce((n, block) => n + (visibleText(block).match(/\S+/g)?.length ?? 0), 0)
  $('word-count').textContent = count.toLocaleString() + (count === 1 ? ' word' : ' words')
}
function review(id: string) {
  if (!current) return
  current.review = id
  drawPanel()
}
function drawPanel() {
  const visible = !!current && panelOpen
  $('panel').hidden = !visible
  $('toggle-alternatives').setAttribute('aria-expanded', String(visible))
  if (!editor || !current) return
  editor.review(visible ? current.review : null)
  if (visible) renderAlternatives($('choices'), editor, current.review, review)
}
function updateToolbar() {
  if (!editor || !current || inspecting) return
  const { state } = editor.view
  undoButton.disabled = undoDepth(state) === 0
  redoButton.disabled = redoDepth(state) === 0
  const { $from } = state.selection
  const block = $from.depth ? $from.node(1) : state.doc.firstChild!
  blockStyle.value = block.type.name === 'heading' ? 'h' + block.attrs.level : 'paragraph'
  for (const el of document.querySelectorAll<HTMLElement>('[data-format]')) {
    const name = ({ bold: 'strong', italic: 'em', highlight: 'highlight' } as Record<string, string>)[el.dataset.format!]
    const mark = state.schema.marks[name]
    const enabled = state.selection.empty ? !!mark.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark)
    el.setAttribute('aria-pressed', String(enabled))
  }
}
function updateSelection() {
  if (!editor || !current || inspecting) return
  updateToolbar()
  current.review = editor.context()?.id ?? null
  drawPanel()
}
function checker(language: string) {
  return loadSpelling(language, ['en','es'].includes(language) ? undefined : code => api.readPack(code))
}
async function selectTab(tab: Tab | null) {
  if (!tab && library.folder) {
    const next = await api.library()
    library.projects = next.projects
    library.folders = next.folders
  }
  await switchTab(tab)
}
async function switchTab(tab: Tab | null) {
  const epoch = ++switching
  if (current) current.scroll = scroll.scrollTop
  current = tab
  editor = null
  for (const item of editors.values()) item.view.dom.parentElement!.hidden = true
  $('writing').hidden = !tab
  $('home').hidden = !!tab
  $('document-tools').hidden = !tab
  $('language-label').hidden = !tab
  $('panel').hidden = !tab || !panelOpen
  drawTabs()
  $('tabs').querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (!tab) {
    renderHome($('home'), library, {
      openDocument, createDocument, moveDocument, rename: renameHomeItem, remove: deleteHomeItem, importFile: () => void importDocument().catch(report),
      chooseFolder: path => void changeFolder('choose', path).catch(report),
      newFolder: () => void changeFolder('new').catch(report),
      openProject: path => void changeProject('open', path).catch(report),
      createProject: () => void changeProject('create').catch(report),
      openSample: () => void changeProject('sample').catch(report)
    })
  } else {
    const doc = record(tab.documentId)
    let instance = editors.get(doc.id)
    if (!instance) {
      let spelling
      try { spelling = await checker(doc.language) }
      catch (error) {
        report(error)
        spelling = { language: doc.language, correct: () => true, suggest: () => [] }
      }
      if (epoch !== switching) return
      const host = element('div')
      $('editors').append(host)
      instance = new WritingEditor(host, doc.manuscript, {
        plugins: [spellingPlugin(spelling)], message: notice,
        change(manuscript) {
          const updated = record(tab.documentId)
          updated.manuscript = manuscript
          changed(updated)
          drawCount()
          if (tabs.some(tab => tab.documentId === doc.id && tab.headingId)) drawTabs()
          drawTrail()
          if (current?.headingId && !manuscript.content.some(block => block.type === 'heading' && block.attrs.id === current?.headingId)) {
            const removed = current
            queueMicrotask(() => { openDocument(doc.id); closeTab(removed) })
          }
        },
        selection: updateSelection
      })
      editors.set(doc.id, instance)
    }
    editor = instance
    instance.view.dom.parentElement!.hidden = false
    inspecting = true
    const found = instance.showSection(tab.headingId)
    inspecting = false
    if (!found && tab.headingId) {
      closeTab(tab)
      openDocument(doc.id)
      return
    }
    const group = tab.review && instance.view.dom.querySelector('[data-choice-id="' + CSS.escape(tab.review) + '"]')
    if (!group || group.closest('[aria-hidden=true]')) tab.review = null
    if (![...language.options].some(option => option.value === doc.language)) language.add(new Option(doc.language + ' (dictionary needed)', doc.language))
    language.value = doc.language
    $('draft-action').replaceChildren(icon('branch'), document.createTextNode(doc.source ? 'Review draft' : 'Create draft'))
    scroll.scrollTop = tab.scroll
    updateToolbar()
  }
  drawCount()
  drawTrail()
  drawPanel()
  saveSession()
}
function openDocument(id: string, headingId?: string) {
  let tab = tabs.find(item => item.documentId === id && item.headingId === (headingId ?? null))
  if (!tab) {
    tab = { documentId: id, headingId: headingId ?? null, scroll: 0, review: null }
    tabs.push(tab)
  }
  void switchTab(tab).catch(report)
}
function closeTab(tab: Tab) {
  const index = tabs.indexOf(tab)
  if (index < 0) return
  tabs.splice(index, 1)
  if (current === tab) void switchTab(tabs[index - 1] ?? tabs[0] ?? null).catch(report)
  else { drawTabs(); saveSession() }
}

async function loadLibrary(next: LibraryState, showHome = false) {
  for (const instance of editors.values()) instance.destroy()
  editors.clear()
  $('editors').replaceChildren()
  current = null
  library = next
  const workspace = library.workspace
  document.body.classList.toggle('welcome', !library.folder)
  $('settings').hidden = !library.folder
  if (!workspace) {
    tabs = []
    status('')
    await switchTab(null)
    return
  }
  const doc = workspace.project.documents[0]
  const saved: Session | null = JSON.parse(localStorage.getItem('tabs:' + workspace.project.id) ?? 'null')
  tabs = saved?.tabs.filter(item => workspace.project.documents.some(doc => doc.id === item.documentId)) ?? (doc ? [{ documentId: doc.id, headingId: null, scroll: 0, review: SAMPLE_SENTENCE }] : [])
  panelOpen = saved?.panel ?? true
  const selected = tabs[saved ? saved.current : 0] ?? null
  await switchTab(showHome ? null : selected)
  status('Saved locally', true)
}
async function changeFolder(action: 'choose'|'new', path?: string) {
  if (!flush()) return
  saveSession()
  const next = action === 'new' ? await api.newFolder() : await api.chooseFolder(path)
  if (!next) return
  if (next.folder === library.folder && next.workspace?.path === library.workspace?.path) {
    library.projects = next.projects
    library.folders = next.folders
    await switchTab(null)
  } else await loadLibrary(next, true)
}
async function changeProject(action: 'open'|'create'|'sample', path?: string) {
  if (!flush()) return
  saveSession()
  let next: Workspace | null
  if (action === 'open') next = await api.open(path)
  else if (action === 'create') next = await api.create()
  else next = await api.sample()
  if (next && next.path !== library.workspace?.path) await loadLibrary(await api.library())
}
function createDocument() {
  const workspace = library.workspace
  if (!workspace) return
  homeItemDialog(modal, 'Create', 'document', '', title => {
    const doc: DocumentRecord = { id: crypto.randomUUID(), title, language: prefs.defaultLanguage, manuscript: { type: 'doc', content: [newBlock()] } }
    const error = api.save(workspace.path, workspace.project.id, doc)
    if (error) throw Error(error)
    workspace.project.documents.push(doc)
    openDocument(doc.id)
  })
}

async function refreshHome(next: LibraryState) {
  if (!next.workspace || next.workspace.project.id !== library.workspace?.project.id) return loadLibrary(next, true)
  library = next
  const remaining = new Set(next.workspace.project.documents.map(doc => doc.id))
  tabs = tabs.filter(tab => remaining.has(tab.documentId))
  for (const id of editors.keys()) if (!remaining.has(id)) removeEditor(id)
  await switchTab(current && remaining.has(current.documentId) ? current : null)
}

async function undoMove() {
  if (!flush()) return
  document.body.inert = true
  try {
    await refreshHome(await api.undoMove())
    notice('Move undone.')
  } finally { document.body.inert = false }
}

function moveDocument(doc: DocumentRecord, destination: RecentProject) {
  const workspace = library.workspace!
  if (!flush()) return
  const move = async () => {
    document.body.inert = true
    try {
      const next = await api.moveDocument(workspace.path, doc.id, destination.path)
      await refreshHome(next)
      notice('Moved “' + doc.title + '” to “' + destination.title + '”.', undoMove)
    } finally { document.body.inert = false }
  }
  const details: string[] = []
  if (doc.source) details.push('This draft will become a standalone document.')
  if (workspace.project.documents.some(draft => draft.source?.documentId === doc.id)) {
    details.push('Its drafts will stay in “' + workspace.project.title + '” as standalone documents.')
  }
  if (details.length) {
    const question = 'Move “' + doc.title + '” to “' + destination.title + '”? '
    homeItemDialog(modal, 'Move', 'document', doc.title, move, question + details.join(' '))
  } else void move().catch(report)
}

function renameHomeItem(item: HomeItem) {
  if (!flush()) return
  homeItemDialog(modal, 'Rename', item.kind, item.title, async title => {
    if (item.kind === 'project') return refreshHome(await api.renameProject(item.path, title))
    const workspace = library.workspace!
    const doc = record(item.id)
    const error = api.save(workspace.path, workspace.project.id, { ...doc, title })
    if (error) throw Error(error)
    doc.title = title
    await switchTab(null)
  })
}

function deleteHomeItem(item: HomeItem) {
  if (!flush()) return
  let detail = 'Move “' + item.title + '” and all its documents to the Trash?'
  if (item.kind === 'document') {
    detail = 'Permanently delete “' + item.title + '” and its version history?'
    if (library.workspace!.project.documents.some(doc => doc.source?.documentId === item.id)) detail += ' Its drafts will stay in the project as standalone documents.'
  }
  homeItemDialog(modal, 'Delete', item.kind, item.title, async () => {
    const next = item.kind === 'project' ? await api.deleteProject(item.path) : await api.deleteDocument(library.workspace!.path, item.id)
    await refreshHome(next)
  }, detail)
}
function togglePanel(open: boolean) {
  panelOpen = open
  if (open && current && !current.review) current.review = editor?.context()?.id ?? null
  drawPanel()
  saveSession()
}
async function updateLanguages() {
  packs = await api.listPacks()
  language.replaceChildren(...languageOptions(packs).map(([code, name]) => new Option(name, code)))
  language.value = activeDocument()?.language ?? prefs.defaultLanguage
  const content = modal.querySelector<HTMLElement>('.settings-body')
  if (content) updateSettingsPacks(content, packs, prefs.defaultLanguage)
}
function settings() {
  const body = showSettings(modal, prefs, library.workspace?.path ?? null, packs, async code => {
    await api.installPack(code)
    await updateLanguages()
    for (const [id, instance] of editors) {
      if (record(id).language === code) setSpellingLanguage(instance.view, await checker(code))
    }
  })
  if (library.workspace) backupSettings(body, flush, () => {
    modal.close()
    saveSession()
    void api.library().then(next => loadLibrary(next)).catch(report)
  })
}
async function importDocument() {
  const workspace = library.workspace
  if (!workspace) return
  const projectPath = workspace.path
  const file = await api.pickFile()
  if (!file) return
  const imported = await importFile(file)
  if (library.workspace?.path !== projectPath) { notice('The project changed during import. Open the intended project and import the file again.'); return }
  const title = file.name.replace(/\.[^.]+$/, '')
  const doc = { id: crypto.randomUUID(), title, language: prefs.defaultLanguage, manuscript: imported.manuscript }
  const error = api.save(workspace.path, workspace.project.id, doc)
  if (error) return notice(error)
  workspace.project.documents.push(doc)
  openDocument(doc.id)
  if (imported.notes.length) {
    const list = element('ul')
    list.append(...imported.notes.map(note => element('li', '', note)))
    modal.replaceChildren(dialogHeader(modal, 'Import notes'), list, button('Done', () => modal.close(), 'primary'))
    modal.showModal()
  }
}
function exportDialog() {
  const doc = activeDocument()
  if (!doc || !current) return
  const range = current.headingId && sectionRange(doc.manuscript, current.headingId)
  const manuscript = range ? { ...doc.manuscript, content: doc.manuscript.content.slice(range.from, range.to) } : doc.manuscript
  const title = label(current)
  async function write(format: ExportFormat) {
    modal.close()
    try { if (await api.exportFile(format, title, manuscript)) notice('Exported ' + title + ' as ' + format.toUpperCase() + '.') }
    catch (error) { report(error) }
  }
  const actions = element('div', 'home-actions')
  actions.append(button('Word document (.docx)', () => void write('docx'), 'outline'), button('PDF (.pdf)', () => void write('pdf'), 'outline'))
  modal.replaceChildren(dialogHeader(modal, 'Export manuscript'), element('p', '', title), actions)
  modal.showModal()
}

function removeEditor(id: string) {
  const instance = editors.get(id)
  const host = instance?.view.dom.parentElement
  instance?.destroy()
  host?.remove()
  editors.delete(id)
}

function reloadRecord(next: DocumentRecord) {
  Object.assign(record(next.id), next)
  removeEditor(next.id)
}

async function drafts() {
  const doc = activeDocument()
  if (!doc || !current || !flush()) return
  if (doc.source) {
    showDraftReview({
      sourceTitle: record(doc.source.documentId).title, draftTitle: doc.title,
      load: () => api.reviewDraft(doc.id),
      apply: async resolutions => {
        const result = await api.applyDraft(doc.id, resolutions)
        reloadRecord(result.source)
        reloadRecord(result.draft)
        await switchTab(current)
      }
    })
    return
  }
  const title = await createDraftDialog(label(current) + ' — draft')
  if (!title) return
  const draft = await api.createDraft(doc.id, current.headingId, title)
  library.workspace!.project.documents.push(draft)
  openDocument(draft.id)
}

function wire() {
  document.body.classList.toggle('mac', api.platform === 'darwin')
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => el.append(icon(el.dataset.icon!)))
  $('toolbar').onmousedown = event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }
  $('toggle-alternatives').onclick = () => togglePanel(!panelOpen)
  $('close-panel').onclick = () => { togglePanel(false); $('toggle-alternatives').focus() }
  $('add-alternative').onclick = () => {
    const id = editor?.addAlternative()
    if (id) { panelOpen = true; review(id) }
  }
  document.querySelectorAll<HTMLElement>('[data-format]').forEach(el => { el.onclick = () => editor?.format(el.dataset.format as Format) })
  blockStyle.onchange = () => editor?.format(blockStyle.value as Format)
  undoButton.onclick = () => { editor?.undo(); editor?.view.focus() }
  redoButton.onclick = () => { editor?.redo(); editor?.view.focus() }
  $('settings').onclick = settings
  $('export').onclick = exportDialog
  $('draft-action').onclick = () => void drafts().catch(report)
  language.onchange = async () => {
    const doc = activeDocument()
    const target = editor
    const code = language.value
    if (!doc || !target) return
    try {
      const spelling = await checker(code)
      if (doc !== activeDocument() || language.value !== code) return
      setSpellingLanguage(target.view, spelling)
      doc.language = code
      changed(doc)
    } catch (error) { language.value = doc.language; report(error) }
  }
  $('history').onclick = () => {
    const doc = activeDocument()
    if (!doc || !flush()) return
    void showHistory(modal, doc, restored => {
      reloadRecord(restored)
      void switchTab(current).catch(report)
    }, notice)
  }
  scroll.addEventListener('scroll', drawTrail, { passive: true })
  window.addEventListener('online', () => void api.online().catch(report))
  window.addEventListener('beforeunload', event => {
    saveSession()
    if (!flush()) { event.preventDefault(); event.returnValue = false }
  })
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); flush(); saveSession() }
  })
}
async function start() {
  applyPreferences(prefs)
  wire()
  await updateLanguages()
  await loadLibrary(await api.library())
}
void start().catch(error => { status('Could not open editor'); report(error) })
