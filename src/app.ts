import { redoDepth, undoDepth } from 'prosemirror-history'
import { backupSettings } from './backup-settings'
import { exportFormats, importFile, type ExportFormat } from './exchange'
import { WritingEditor, type Format } from './editor'
import { headingSpawns } from './section'
import { manuscriptWithOrigin, newBlock, SAMPLE_SENTENCE, sectionRange, visibleText } from './model'
import type { DocumentRecord, LibraryState, RecentProject, Workspace } from './project-types'
import './desktop'
import { checkWriting, configureWriting, writingPlugin } from './writing-checks'
import { observeWritingPreferences, writingPreferences } from './writing-preferences'
import { renderWritingChecks } from './writing-ui'
import { writingSettings } from './writing-settings'
import { renderAlternatives } from './alternatives'
import { showDraftReview, createDraftDialog } from './draft-ui'
import { homeItemDialog, renderHome, type HomeItem } from './home'
import { showPosts } from './posts-ui'
import { showPublish } from './publish-ui'
import { siteSettings } from './site-settings'
import { authorSettings } from './author-settings'
import { translationSettings } from './translation-settings'
import { drawTranslationNote, languageName, showTranslate } from './translate-ui'
import { typographySettings } from './typography-settings'
import { listCharacters, manuscriptCharacters, registerFontFaces } from './typography'
import { trackWriting } from './writing-evidence'
import { showHistory } from './history'
import { dialogHeader, applyPreferences, languageOptions, preferences, showSettings, type SettingsSection } from './settings'
import { $, button, element, errorMessage, icon, spawnButton } from './ui'

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
const expandedSpawns = new Set<string>()
const evidence = new Map<WritingEditor, ReturnType<typeof trackWriting>>()
const pending = new Map<string, { projectId: string; path: string; doc: DocumentRecord }>()
let library: LibraryState = { folder: null, folders: [], projects: [], workspace: null }
let tabs: Tab[] = []
let current: Tab | null = null
let editor: WritingEditor | null = null
let panelOpen = true
let panelView: 'alternatives' | 'writing' = 'alternatives'
let timer: ReturnType<typeof setTimeout>
let noticeTimer: ReturnType<typeof setTimeout>
let switching = 0
let inspecting = false

function record(id: string) { return library.workspace!.project.documents.find(doc => doc.id === id)! }
function activeDocument() { return current ? record(current.documentId) : null }
function notice(text: string, undo?: () => Promise<void>, actionLabel = 'Undo') {
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
    const action = button(actionLabel, () => void undo().catch(report), 'outline')
    action.onfocus = () => clearTimeout(noticeTimer)
    action.onblur = dismissLater
    banner.append(action)
  }
  dismissLater()
}
function report(error: unknown) { notice(errorMessage(error)) }
function status(text: string, saved = false) {
  $('save-status').textContent = text
  if (saved) $('save-status').prepend(icon('check'))
}
function saveSession() {
  if (!library.workspace) return
  if (current) current.scroll = scroll.scrollTop
  try {
    localStorage.setItem('tabs:' + library.workspace.project.id, JSON.stringify({ tabs, current: current ? tabs.indexOf(current) : -1, panel: panelOpen }))
  } catch { notice('Tinto could not remember your open tabs.') }
}
function saveFailed(problem: string) {
  status('Save failed')
  notice(problem)
  return false
}
function flush(includeEvidence = true): boolean {
  clearTimeout(timer)
  for (const [key, entry] of pending) {
    const problem = api.save(entry.path, entry.projectId, entry.doc)
    if (problem) return saveFailed(problem)
    pending.delete(key)
  }
  if (includeEvidence) {
    for (const tracker of evidence.values()) {
      const problem = tracker.flush()
      if (problem) return saveFailed(problem)
    }
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
  timer = setTimeout(() => flush(false), 450)
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
  const home = $('home-tab')
  home.classList.toggle('current', !current)
  home.querySelector('button')!.ariaCurrent = current ? null : 'page'
  function item(tab: Tab) {
    const key = tab.documentId + '/' + (tab.headingId ?? '')
    const wrap = element('div', 'tab' + (tab === current ? ' current' : ''))
    const title = label(tab)
    const select = button('', () => void selectTab(tab).catch(report), '', tab.headingId ? 'link' : 'book')
    select.title = title
    select.dataset.tabKey = key
    select.append(element('span', 'tab-label', title))
    if (tab === current) select.setAttribute('aria-current', 'page')
    const close = button('', () => closeTab(tab), 'close-tab', 'close')
    close.dataset.tabKey = 'close:' + key
    close.setAttribute('aria-label', 'Close ' + title)
    wrap.append(select, close)
    return wrap
  }
  $('document-tabs').replaceChildren(...tabs.map(item))
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
      const block = editor.markdown && doc.manuscript.content.find(block => block.attrs.id === heading.dataset.blockId)
      passed.push((block ? visibleText(block) : heading.textContent) || 'Untitled heading')
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
function openSpawn(id: string) {
  const doc = activeDocument()
  if (!doc) return
  if (!doc.spawnedHeadingIds?.includes(id)) {
    const workspace = library.workspace!
    const spawnedHeadingIds = [...(doc.spawnedHeadingIds ?? []), id]
    const error = api.save(workspace.path, workspace.project.id, { ...doc, spawnedHeadingIds })
    if (error) return notice(error)
    doc.spawnedHeadingIds = spawnedHeadingIds
  }
  openDocument(doc.id, id)
  editor?.view.focus()
}
function drawHeadingList() {
  const list = $('heading-list')
  const doc = activeDocument()
  if (!doc || !current) return
  const range = current.headingId && sectionRange(doc.manuscript, current.headingId)
  const blocks = range ? doc.manuscript.content.slice(range.from, range.to) : doc.manuscript.content
  const baseLevel = range ? blocks[0]?.attrs.level ?? 1 : 1
  list.replaceChildren()
  for (const block of blocks) {
    if (block.type !== 'heading') continue
    const { id, level = 1 } = block.attrs
    const title = visibleText(block) || 'Untitled heading'
    const row = element('div', 'heading-entry')
    row.style.paddingInlineStart = (level - baseLevel) * 12 + 'px'
    const jump = button(title, () => { list.hidePopover(); editor?.jumpToHeading(id) }, 'heading-jump')
    jump.autofocus = !list.childElementCount
    row.append(jump)
    const exists = doc.spawnedHeadingIds?.includes(id) ?? false
    if (id !== current.headingId || !exists) row.append(spawnButton(title, exists, () => { list.hidePopover(); openSpawn(id) }))
    list.append(row)
  }
  if (!list.childElementCount) list.append(element('p', '', 'No headings yet.'))
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
  panelView = 'alternatives'
  current.review = id
  drawPanel()
}
function drawPanel() {
  const visible = !!current && panelOpen && (panelView === 'writing' || !editor?.markdown)
  $('panel').hidden = !visible
  $('toggle-alternatives').setAttribute('aria-expanded', String(visible && panelView === 'alternatives'))
  $('check-writing').setAttribute('aria-expanded', String(visible && panelView === 'writing'))
  if (!editor || !current) return
  const alternatives = panelView === 'alternatives'
  $('panel-title').textContent = alternatives ? 'Alternatives' : 'Writing checks'
  $('panel').setAttribute('aria-label', alternatives ? 'Alternatives' : 'Writing checks')
  $('close-panel').setAttribute('aria-label', alternatives ? 'Close alternatives' : 'Close writing checks')
  $('close-panel').title = alternatives ? 'Close alternatives' : 'Close writing checks'
  for (const [id, selected] of [['panel-alternatives', alternatives], ['panel-writing', !alternatives]] as const) {
    $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1
  }
  ;($('panel-alternatives') as HTMLButtonElement).disabled = editor.markdown
  $('choices').hidden = !alternatives
  $('writing-checks').hidden = alternatives
  editor.review(visible && alternatives ? current.review : null)
  if (visible && alternatives) renderAlternatives($('choices'), editor, current.review, review)
  else if (visible) renderWritingChecks($('writing-checks'), editor.view, notice)
}
function updateToolbar() {
  if (!editor || !current || inspecting) return
  const { state } = editor.view
  const markdown = editor.markdown
  $('markdown').setAttribute('aria-pressed', String(markdown))
  blockStyle.disabled = markdown
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-format], #add-alternative, #toggle-alternatives')) control.disabled = markdown
  undoButton.disabled = undoDepth(state) === 0
  redoButton.disabled = redoDepth(state) === 0
  const { $from } = state.selection
  const block = $from.depth ? $from.node(1) : state.doc.firstChild!
  blockStyle.value = block.type.name === 'heading' ? 'h' + block.attrs.level : 'paragraph'
  for (const el of document.querySelectorAll<HTMLElement>('[data-format]')) {
    const name = ({ bold: 'strong', italic: 'em', underline: 'highlight' } as Record<string, string>)[el.dataset.format!]
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
  $('heading-list').hidePopover()
  $('headings').hidden = !tab
  $('language-label').hidden = !tab
  $('panel').hidden = !tab || !panelOpen
  drawTabs()
  $('tabs').querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (!tab) {
    drawTranslationNote($('translation-note'), null, [], { open: openDocument, again: translateDialog })
    renderHome($('home'), library, expandedSpawns, {
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
      if (epoch !== switching) return
      const host = element('div')
      $('editors').append(host)
      instance = new WritingEditor(host, doc.manuscript, {
        plugins: [writingPlugin({ language: doc.language, preferences: writingPreferences(), check: request => api.checkWriting(request), coach: request => api.coachWriting(request), changed: () => { if (current?.documentId === doc.id && panelView === 'writing') drawPanel() }, message: notice }), headingSpawns(() => record(doc.id).spawnedHeadingIds ?? [], openSpawn)], message: notice,
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
      const workspace = library.workspace!
      evidence.set(instance, trackWriting(instance.view, { path: workspace.path, projectId: workspace.project.id, documentId: doc.id },
        (where, kind, sample) => api.recordWriting(where.path, where.projectId, where.documentId, kind, sample)))
    }
    editor = instance
    instance.view.dom.parentElement!.hidden = false
    inspecting = true
    instance.setMarkdown(localStorage.getItem('markdown:' + doc.id) === '1')
    const found = instance.showSection(tab.headingId)
    inspecting = false
    if (!found && tab.headingId) {
      closeTab(tab)
      openDocument(doc.id)
      return
    }
    const group = tab.review && instance.view.dom.querySelector('[data-choice-id="' + CSS.escape(tab.review) + '"]')
    if (!group || group.closest('[aria-hidden=true]')) tab.review = null
    updateLanguages()
    $('draft-action').replaceChildren(icon('draft'), document.createTextNode(doc.source ? 'Review draft' : 'Create draft'))
    drawTranslationNote($('translation-note'), doc, library.workspace!.project.documents, { open: id => openDocument(id), again: translateDialog })
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

// The writing measured in an editor is recorded before the editor goes.
function destroyEditor(instance: WritingEditor) {
  evidence.get(instance)?.stop()
  evidence.delete(instance)
  instance.destroy()
}
async function loadLibrary(next: LibraryState, showHome = false) {
  for (const instance of editors.values()) destroyEditor(instance)
  editors.clear()
  expandedSpawns.clear()
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
  // Documents may have left the project while it was closed, so the saved tab
  // is found before filtering rather than by its old position.
  const savedTab = saved?.tabs[saved.current] ?? null
  tabs = saved?.tabs.filter(item => workspace.project.documents.some(doc => doc.id === item.documentId)) ?? (doc ? [{ documentId: doc.id, headingId: null, scroll: 0, review: SAMPLE_SENTENCE }] : [])
  panelOpen = saved?.panel ?? true
  // A position outside the saved list means Home was showing.
  const selected = saved ? (savedTab && tabs.includes(savedTab) ? savedTab : null) : tabs[0] ?? null
  await switchTab(showHome ? null : selected)
  status('Saved locally', true)
  void checkManuscriptFont().catch(report)
  startUpdateChecks()
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
  if (next.workspace.path !== library.workspace.path) {
    for (const tracker of evidence.values()) tracker.renameProject(next.workspace.path)
  }
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

async function deleteHomeItem(item: HomeItem) {
  if (!flush()) return
  let detail = 'Move “' + item.title + '” and all its documents to the Trash?'
  if (item.kind === 'document') {
    detail = 'Permanently delete “' + item.title + '” and its version history?'
    if (library.workspace!.project.documents.some(doc => doc.source?.documentId === item.id)) detail += ' Its drafts will stay in the project as standalone documents.'
    // Posts stay on their websites, and Tinto could no longer update or remove them.
    const posts = (await api.allPosts().catch(() => [])).filter(post => post.documentId === item.id)
    const sites = [...new Set(posts.map(post => post.siteName ?? 'a removed website'))]
    if (posts.length) detail += ' It is posted on ' + sites.join(', ') + '. Those posts stay online and Tinto can no longer update or remove them, so unpublish them first from Publish if they should go.'
  }
  homeItemDialog(modal, 'Delete', item.kind, item.title, async () => {
    const next = item.kind === 'project' ? await api.deleteProject(item.path) : await api.deleteDocument(library.workspace!.path, item.id)
    await refreshHome(next)
  }, detail)
}
function revealPanel() {
  if (matchMedia('(max-width: 580px)').matches && !$('panel').hidden) {
    $('panel').scrollIntoView({ block: 'start' })
    $('close-panel').focus({ preventScroll: true })
  }
}
function togglePanel(open: boolean) {
  panelOpen = open
  if (open && current && !current.review) current.review = editor?.context()?.id ?? null
  drawPanel()
  if (open) revealPanel()
  saveSession()
}
function updateLanguages() {
  const code = activeDocument()?.language ?? prefs.defaultLanguage
  language.replaceChildren(...languageOptions().map(([code, name]) => new Option(name, code)))
  if (![...language.options].some(option => option.value === code)) {
    const legacy = new Option(languageName(code) + ' (checks unavailable)', code)
    legacy.disabled = true
    language.add(legacy)
  }
  language.value = code
}
// The characters of every manuscript in the open project, to check a font against.
function projectCharacters(): string | null {
  return library.workspace ? manuscriptCharacters(library.workspace.project.documents.map(doc => doc.manuscript)) : null
}
// A newer release is looked for when Tinto opens, unless the writer turned it off.
// It is looked for again once a day while Tinto stays open; each new version
// is announced once per session.
let updateTimer: ReturnType<typeof setInterval> | null = null
let announced = ''
function startUpdateChecks() {
  if (updateTimer) return
  void checkForUpdate()
  updateTimer = setInterval(() => void checkForUpdate(), api.updateInterval)
}
async function checkForUpdate() {
  if (!prefs.checkUpdates) return
  const release = await api.checkForUpdate().catch(() => null)
  if (!release || release.version === announced) return
  announced = release.version
  notice('Tinto ' + release.version + ' is available. You have ' + api.version + '.', () => api.openRelease(), 'Download')
}
// A font the writer added is checked once per project and session when the project opens.
const fontChecks = new Set<string>()
async function checkManuscriptFont() {
  const workspace = library.workspace
  if (!workspace || !prefs.font.startsWith('user:')) return
  const key = workspace.project.id + ' ' + prefs.font
  if (fontChecks.has(key)) return
  fontChecks.add(key)
  const check = await api.checkFont(prefs.font.slice(5), projectCharacters() ?? '')
  if (!check) {
    prefs.font = 'book'
    applyPreferences(prefs)
    notice('The manuscript font is no longer in Tinto, so the text uses Book serif.')
  } else if (check.missing.length) {
    notice('“' + check.family + '” cannot draw ' + check.missing.length + (check.missing.length === 1 ? ' character' : ' characters') + ' in this project: ' + listCharacters(check.missing) + '. They appear in a fallback font.')
  }
}
function settings(section?: SettingsSection) {
  const panels = showSettings(modal, prefs, library.workspace?.path ?? null, section)
  typographySettings(panels, prefs, projectCharacters)
  writingSettings(panels.writing, languageOptions())
  // Drive backup has not been tried with a real Google account yet, so it is experimental.
  if (library.workspace && api.experimental) backupSettings(panels.project, flush, () => {
    modal.close()
    saveSession()
    void api.library().then(next => loadLibrary(next)).catch(report)
  })
  translationSettings(panels.writing)
  authorSettings(panels.author)
  siteSettings(panels.websites)
}
async function importDocument() {
  const workspace = library.workspace
  if (!workspace) return
  const projectPath = workspace.path
  const markdownImport = prefs.markdownImports
  const file = await api.pickFile()
  if (!file) return
  const imported = await importFile(file)
  if (library.workspace?.path !== projectPath) { notice('The project changed during import. Open the intended project and import the file again.'); return }
  const title = file.name.replace(/\.[^.]+$/, '')
  // Imported text was written elsewhere, and keeps saying so as it is edited.
  const doc = { id: crypto.randomUUID(), title, language: prefs.defaultLanguage, manuscript: manuscriptWithOrigin(imported.manuscript, 'imported') }
  const error = api.save(workspace.path, workspace.project.id, doc)
  if (error) return notice(error)
  if (markdownImport && /\.(md|markdown)$/i.test(file.name)) localStorage.setItem('markdown:' + doc.id, '1')
  api.recordWriting(workspace.path, workspace.project.id, doc.id, 'import', { characters: [...doc.manuscript.content.map(visibleText).join('')].length })
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
  const language = doc.language
  async function write(format: ExportFormat) {
    modal.close()
    try {
      const exported = await api.exportFile(format, title, manuscript, language, prefs.font)
      if (exported) notice('Exported ' + title + ' as ' + format.toUpperCase() + '.' + (exported.note ? ' ' + exported.note : ''))
    }
    catch (error) { report(error) }
  }
  const actions = element('div', 'export-formats')
  for (const format of Object.keys(exportFormats) as ExportFormat[]) {
    actions.append(button(exportFormats[format] + ' (.' + format + ')', () => void write(format), 'outline'))
  }
  modal.replaceChildren(dialogHeader(modal, 'Export manuscript'), element('p', '', title), actions)
  modal.showModal()
}
function publishDialog() {
  const doc = activeDocument()
  if (!doc || !current || !flush()) return
  const nameOf = (code: string) => languageOptions().find(([value]) => value === code)?.[1] ?? languageName(code)
  const title = current.headingId ? label(current) : doc.title
  // A translation goes out with its original, and an original with its first translation.
  const documents = library.workspace!.project.documents
  const partnerDoc = doc.translation ? documents.find(item => item.id === doc.translation!.of) : documents.find(item => item.translation?.of === doc.id)
  const partner = partnerDoc && {
    documentId: partnerDoc.id, title: partnerDoc.title, language: partnerDoc.language, languageName: nameOf(partnerDoc.language),
    kind: doc.translation ? 'original' as const : 'translation' as const
  }
  void showPublish(modal, {
    documentId: doc.id, headingId: current.headingId, title, language: doc.language, languageName: nameOf(doc.language),
    ...(doc.translation ? { translationFrom: nameOf(doc.translation.from) } : {}), ...(partner ? { partner } : {})
  }, () => settings('websites'), notice, postsDialog).catch(report)
}
// A document becomes a marked translation in another document; see translate-ui.ts.
function translateDialog() {
  const doc = activeDocument()
  const workspace = library.workspace
  if (!doc || !workspace) return
  const where = { path: workspace.path, projectId: workspace.project.id }
  void showTranslate(modal, {
    doc, documents: workspace.project.documents, languages: languageOptions(), flush, notice,
    create(next) {
      const problem = api.save(where.path, where.projectId, next)
      if (problem) return problem
      workspace.project.documents.push(next)
      return null
    },
    replace(next) {
      const problem = api.save(where.path, where.projectId, next)
      if (problem) return problem
      reloadRecord(next)
      return null
    },
    record: (id, characters) => api.recordWriting(where.path, where.projectId, id, 'translate', { characters }),
    open: id => openDocument(id),
    openSettings: () => settings('writing')
  }).catch(report)
}
function postsDialog() {
  void showPosts(modal, (id, headingId) => openDocument(id, headingId ?? undefined)).catch(report)
}

function removeEditor(id: string) {
  const instance = editors.get(id)
  const host = instance?.view.dom.parentElement
  if (instance) destroyEditor(instance)
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
  $('home-tab').querySelector('button')!.onclick = () => void selectTab(null).catch(report)
  $('heading-list').addEventListener('beforetoggle', event => { if (event.newState === 'open') drawHeadingList() })
  $('toolbar').onmousedown = event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }
  $('toggle-alternatives').onclick = () => { const open = !panelOpen || panelView !== 'alternatives'; panelView = 'alternatives'; togglePanel(open) }
  $('check-writing').onclick = () => { if (!editor) return; panelView = 'writing'; panelOpen = true; checkWriting(editor.view); drawPanel(); revealPanel(); saveSession() }
  $('panel-alternatives').onclick = () => { panelView = 'alternatives'; drawPanel() }
  $('panel-writing').onclick = () => { panelView = 'writing'; drawPanel() }
  $('panel-tabs').onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const id = event.key === 'Home' ? 'panel-alternatives' : event.key === 'End' ? 'panel-writing' : panelView === 'writing' ? 'panel-alternatives' : 'panel-writing'
    const tab = $(id) as HTMLButtonElement
    if (!tab.disabled) { tab.click(); tab.focus() }
  }
  observeWritingPreferences(preferences => { for (const instance of editors.values()) configureWriting(instance.view, { preferences }) })
  $('markdown').onclick = () => {
    if (!editor || !current) return
    editor.setMarkdown(!editor.markdown)
    localStorage.setItem('markdown:' + current.documentId, editor.markdown ? '1' : '0')
    updateToolbar()
    drawPanel()
    drawTrail()
    editor.view.focus()
  }
  $('close-panel').onclick = () => { togglePanel(false); $(panelView === 'writing' ? 'check-writing' : 'toggle-alternatives').focus() }
  $('add-alternative').onclick = () => {
    const id = editor?.addAlternative()
    if (id) { panelOpen = true; review(id); revealPanel() }
  }
  document.querySelectorAll<HTMLElement>('[data-format]').forEach(el => { el.onclick = () => editor?.format(el.dataset.format as Format) })
  blockStyle.onchange = () => editor?.format(blockStyle.value as Format)
  undoButton.onclick = () => { editor?.undo(); editor?.view.focus() }
  redoButton.onclick = () => { editor?.redo(); editor?.view.focus() }
  $('settings').onclick = () => settings()
  // Show origins tints text the writer did not type in Tinto. It is off by default.
  const origins = $('show-origins')
  const showOrigins = (on: boolean) => {
    document.body.classList.toggle('show-origins', on)
    origins.setAttribute('aria-pressed', String(on))
    try { localStorage.setItem('show-origins', on ? '1' : '0') } catch { /* A preference only. */ }
  }
  showOrigins(localStorage.getItem('show-origins') === '1')
  origins.onclick = () => showOrigins(!document.body.classList.contains('show-origins'))
  $('export').onclick = exportDialog
  $('publish').onclick = publishDialog
  $('translate').onclick = translateDialog
  $('draft-action').onclick = () => void drafts().catch(report)
  language.onchange = async () => {
    const doc = activeDocument()
    const target = editor
    const code = language.value
    if (!doc || !target) return
    try {
      configureWriting(target.view, { language: code })
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
    if (!flush()) {
      event.preventDefault()
      event.returnValue = false
    } else saveSession()
  })
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); flush(); saveSession() }
  })
}
async function start() {
  applyPreferences(prefs)
  registerFontFaces(await api.fonts().catch(() => []))
  wire()
  updateLanguages()
  await loadLibrary(await api.library())
}
void start().catch(error => { status('Could not open editor'); report(error) })
