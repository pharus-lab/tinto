import type { Workspace } from './project-types'
import { visibleText } from './model'
import { button, element } from './ui'

interface HomeActions {
  openDocument(id: string, heading?: string): void
  openProject(index?: number): void
  createProject(): void
  createDocument(): void
  importFile(): void
}
export function renderHome(host: HTMLElement, workspace: Workspace, actions: HomeActions) {
  const header = element('div', 'home-heading')
  const commands = element('div', 'home-actions')
  commands.append(button('Import file', actions.importFile, 'outline', 'page'), button('Open project', () => actions.openProject(), 'outline', 'folder'), button('New project', actions.createProject, 'primary', 'plus'))
  header.append(element('h1', '', 'Projects'), commands)
  const columns = element('div', 'home-columns')
  const projects = element('div')
  projects.append(element('h2', '', 'On this computer'))
  workspace.recent.forEach((item, index) => {
    const row = button(item.title, () => actions.openProject(index), 'project-entry', 'folder')
    row.title = item.path
    row.setAttribute('aria-current', String(workspace.path === item.path))
    projects.append(row)
  })
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
  columns.append(projects, list)
  host.replaceChildren(header, columns)
}
