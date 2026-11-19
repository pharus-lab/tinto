import type { LibraryState } from './project-types'
import { visibleText } from './model'
import { button, element } from './ui'

interface FolderActions {
  chooseFolder(folder?: string): void
  newFolder(): void
}
export interface HomeActions extends FolderActions {
  openDocument(id: string, heading?: string): void
  openProject(path?: string): void
  createProject(): void
  createDocument(): void
  importFile(): void
  openSample(): void
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

export function renderHome(host: HTMLElement, library: LibraryState, actions: HomeActions) {
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
  const projects = element('div')
  projects.append(element('h2', '', 'Projects in this folder'))
  for (const project of library.projects) {
    const row = button(project.title, () => actions.openProject(project.path), 'project-entry', 'folder')
    row.title = project.path
    row.setAttribute('aria-current', String(workspace?.path === project.path))
    projects.append(row)
  }
  columns.append(projects)
  host.append(columns)
  if (!workspace) return

  const list = element('div', 'document-list')
  const heading = element('div', 'doc-heading')
  heading.append(element('h2', '', workspace.project.title), button('New document', actions.createDocument, '', 'plus'))
  list.append(heading)
  for (const doc of workspace.project.documents) {
    const row = button(doc.title, () => actions.openDocument(doc.id), 'doc-row', doc.source ? 'branch' : 'book')
    if (doc.source) row.append(element('small', 'draft-label', 'Independent draft'))
    list.append(row)
    for (const block of doc.manuscript.content) {
      if (block.type !== 'heading') continue
      const section = button(visibleText(block) || 'Untitled heading', () => actions.openDocument(doc.id, block.attrs.id), 'section-row', 'link')
      section.title = 'Open linked section'
      list.append(section)
    }
  }
  columns.append(list)
}
