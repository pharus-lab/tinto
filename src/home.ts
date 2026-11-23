import type { DocumentRecord, LibraryState, RecentProject } from './project-types'
import { visibleText } from './model'
import { dialogHeader } from './settings'
import { attachMenu, button, contextMenu, element, errorMessage } from './ui'

export type HomeItem = { kind: 'project'; path: string; title: string } | { kind: 'document'; id: string; title: string }

interface FolderActions {
  chooseFolder(folder?: string): void
  newFolder(): void
}
export interface HomeActions extends FolderActions {
  openDocument(id: string, heading?: string): void
  openProject(path?: string): void
  createProject(): void
  createDocument(): void
  moveDocument(doc: DocumentRecord, destination: RecentProject): void
  importFile(): void
  openSample(): void
  rename(item: HomeItem): void
  remove(item: HomeItem): void
}

export function homeItemDialog(dialog: HTMLDialogElement, action: 'Create' | 'Rename' | 'Delete' | 'Move', kind: HomeItem['kind'], title: string, apply: (name: string) => void | Promise<void>, detail = '') {
  const form = element('form')
  const name = element('input')
  const confirm = action === 'Delete' || action === 'Move'
  if (confirm) form.append(element('p', '', detail))
  else {
    const label = element('label', 'field', kind === 'project' ? 'Project name' : 'Document title')
    name.type = 'text'
    name.required = true
    name.value = title
    label.append(name)
    form.append(label)
  }
  const actions = element('div', 'dialog-actions')
  const cancel = button('Cancel', () => dialog.close(), 'outline')
  const submit = element('button', 'primary', action === 'Create' ? 'Create document' : action)
  submit.type = 'submit'
  actions.append(cancel, submit)
  const error = element('p')
  error.setAttribute('role', 'alert')
  form.append(error, actions)
  form.onsubmit = async event => {
    event.preventDefault()
    if (!confirm && !name.value.trim()) { name.focus(); return }
    dialog.inert = true
    try { await apply(name.value.trim()); dialog.close() }
    catch (problem) { error.textContent = errorMessage(problem) }
    finally { dialog.inert = false }
  }
  const heading = action === 'Create' ? 'New document' : action + ' ' + kind
  dialog.replaceChildren(dialogHeader(dialog, heading), form)
  dialog.showModal()
  if (confirm) cancel.focus()
  else { name.focus(); name.select() }
}

export function renderWelcome(host: HTMLElement, actions: FolderActions) {
  const welcome = element('div', 'folder-welcome')
  const commands = element('div', 'home-actions')
  commands.append(button('Choose folder', () => actions.chooseFolder(), 'primary', 'folder'), button('New folder', actions.newFolder, 'outline', 'plus'))
  welcome.append(element('h1', '', 'Choose your Tinto folder'), element('p', '', 'Tinto stores your .tinto project files here. You can switch folders from Home.'), commands)
  host.replaceChildren(welcome)
}

function folderBar(library: LibraryState, actions: FolderActions) {
  const bar = element('div', 'folder-bar')
  const details = element('div', 'folder-details')
  const label = element('label', 'folder-picker', 'Tinto folder')
  const select = element('select')
  const folderNames = library.folders.map(path => path.split('/').pop() || path)
  library.folders.forEach((path, index) => {
    const name = folderNames[index]
    const repeated = folderNames.indexOf(name) !== folderNames.lastIndexOf(name)
    const option = new Option(repeated ? path : name, path)
    option.title = path
    select.add(option)
  })
  select.value = library.folder ?? ''
  select.onchange = () => {
    const next = select.value
    select.value = library.folder ?? ''
    actions.chooseFolder(next)
  }
  label.append(select)
  details.append(label, element('div', 'folder-path', library.folder ?? ''))
  const commands = element('div', 'home-actions')
  commands.append(button('Choose folder', () => actions.chooseFolder(), 'outline', 'folder'), button('New folder', actions.newFolder, 'outline', 'plus'))
  bar.append(details, commands)
  return bar
}

interface SpawnBranch { id: string; title: string; level: number; children: SpawnBranch[] }

function spawnTree(doc: DocumentRecord) {
  const roots: SpawnBranch[] = []
  const ancestors: SpawnBranch[] = []
  const spawned = new Set(doc.spawnedHeadingIds)
  for (const block of doc.manuscript.content) {
    if (block.type !== 'heading') continue
    const { id, level = 1 } = block.attrs
    // Even an unspawned heading can end the previous spawn's section.
    while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop()
    if (!spawned.has(id)) continue
    const branch: SpawnBranch = { id, title: visibleText(block) || 'Untitled heading', level, children: [] }
    const siblings = ancestors.at(-1)?.children ?? roots
    siblings.push(branch)
    ancestors.push(branch)
  }
  return roots
}

export function renderHome(host: HTMLElement, library: LibraryState, expanded: Set<string>, actions: HomeActions) {
  if (!library.folder) return renderWelcome(host, actions)
  const workspace = library.workspace
  const header = element('div', 'home-heading')
  const commands = element('div', 'home-actions')
  if (workspace) commands.append(button('Import file', actions.importFile, 'outline', 'page'))
  commands.append(button('Open project', () => actions.openProject(), 'outline', 'folder'), button('New project', actions.createProject, 'primary', 'plus'))
  header.append(element('h1', '', 'Projects'), commands)
  host.replaceChildren(header, folderBar(library, actions))

  if (!library.projects.length) {
    const empty = element('div', 'empty-folder')
    empty.append(element('p', '', 'There are no Tinto projects in this folder yet.'), button('Open sample project', actions.openSample, 'outline', 'book'))
    host.append(empty)
    return
  }

  const columns = element('div', 'home-columns')
  const menu = contextMenu()
  function itemMenu(row: HTMLButtonElement, item: HomeItem) {
    attachMenu(row, menu, item.title, [['Rename', () => actions.rename(item)], ['Delete', () => actions.remove(item)]])
  }
  const projects = element('div')
  let dragged: DocumentRecord | null = null
  projects.append(element('h2', '', 'Projects in this folder'))
  for (const project of library.projects) {
    const row = button(project.title, () => actions.openProject(project.path), 'project-entry', 'folder')
    row.title = project.path
    row.setAttribute('aria-current', String(workspace?.path === project.path))
    itemMenu(row, { kind: 'project', ...project })
    if (workspace && project.path !== workspace.path) {
      row.ondragover = event => {
        if (!dragged) return
        event.preventDefault()
        event.dataTransfer!.dropEffect = 'move'
        row.classList.add('drop-target')
      }
      row.ondragleave = event => {
        if (!row.contains(event.relatedTarget as Node)) row.classList.remove('drop-target')
      }
      row.ondrop = event => {
        if (!dragged) return
        event.preventDefault()
        row.classList.remove('drop-target')
        actions.moveDocument(dragged, project)
      }
    }
    projects.append(row)
  }
  columns.append(projects)
  host.append(columns, menu)
  if (!workspace) return

  const list = element('div', 'document-list')
  const heading = element('div', 'doc-heading')
  heading.append(element('h2', '', workspace.project.title), button('New document', actions.createDocument, '', 'plus'))
  list.append(heading)
  const documents = element('ul', 'spawn-tree')
  list.append(documents)
  if (!workspace.project.documents.length) list.append(element('p', '', 'No documents yet.'))
  for (const doc of workspace.project.documents) {
    const row = button(doc.title, () => actions.openDocument(doc.id), 'doc-row', doc.source ? 'draft' : 'book')
    if (doc.source) row.append(element('small', 'draft-label', 'Independent draft'))
    if (doc.translation) row.append(element('small', 'draft-label', 'Automatic translation'))
    itemMenu(row, { kind: 'document', id: doc.id, title: doc.title })
    row.draggable = library.projects.length > 1
    if (row.draggable) row.title = 'Drag to another project to move this document'
    row.ondragstart = event => {
      dragged = doc
      event.dataTransfer!.effectAllowed = 'move'
      event.dataTransfer!.setData('application/x-tinto-document', doc.id)
    }
    row.ondragend = () => {
      dragged = null
      projects.querySelector('.drop-target')?.classList.remove('drop-target')
    }
    function treeItem(link: HTMLButtonElement, title: string, key: string, children: SpawnBranch[]) {
      const item = element('li')
      const entry = element('div', 'tree-entry')
      item.append(entry)
      entry.append(link)
      if (children.length) {
        const group = element('ul', 'spawn-tree')
        for (const child of children) {
          const section = button(child.title, () => actions.openDocument(doc.id, child.id), 'section-row', 'link')
          group.append(treeItem(section, child.title, doc.id + '/' + child.id, child.children))
        }
        const toggle = button('', () => {
          if (expanded.has(key)) expanded.delete(key)
          else expanded.add(key)
          update()
        }, 'tree-toggle', 'chev')
        function update() {
          const open = expanded.has(key)
          group.hidden = !open
          toggle.setAttribute('aria-expanded', String(open))
          toggle.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + title)
        }
        update()
        entry.prepend(toggle)
        item.append(group)
      }
      return item
    }
    documents.append(treeItem(row, doc.title, doc.id, spawnTree(doc)))
  }
  columns.append(list)
}
