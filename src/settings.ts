import { button, element } from './ui'
import { THEMES, fontStack } from './typography'
import { supportedWritingLanguage, WRITING_LANGUAGES } from './writing-types'
import { applyToolbar, toolIds, TOOLS } from './toolbar'

export interface Preferences {
  appearance: string
  theme: string
  font: string
  size: number
  leading: number
  lineNumbers: boolean
  markdownImports: boolean
  // Ask GitHub for a newer release when Tinto opens.
  checkUpdates: boolean
  textWidth: 'fixed-width' | 'fixed-margin'
  columnWidth: number
  sideMargin: number
  defaultLanguage: string
  // Toolbar tools the writer hid; all are shown by default.
  hiddenTools: string[]
}
export function preferences(): Preferences {
  const saved = JSON.parse(localStorage.getItem('reading') ?? '{}')
  return {
    appearance: 'system', theme: 'tinto', font: 'book', size: 21, leading: 1.72,
    columnWidth: 680, sideMargin: 48, lineNumbers: false, markdownImports: false, checkUpdates: true, ...saved,
    defaultLanguage: supportedWritingLanguage(saved?.defaultLanguage) ? saved.defaultLanguage : 'en',
    // A centered column of about 66 characters, unless the writer chose margins.
    textWidth: saved?.textWidth === 'fixed-margin' ? 'fixed-margin' : 'fixed-width',
    hiddenTools: toolIds(saved?.hiddenTools)
  }
}
export function applyPreferences(prefs: Preferences) {
  const style = document.documentElement.style
  style.colorScheme = prefs.appearance === 'system' ? 'light dark' : prefs.appearance
  document.documentElement.dataset.theme = THEMES.some(([id]) => id === prefs.theme) ? prefs.theme : 'tinto'
  style.setProperty('--serif', fontStack(prefs.font))
  style.setProperty('--size', prefs.size + 'px')
  style.setProperty('--leading', String(prefs.leading))
  document.documentElement.dataset.textWidth = prefs.textWidth
  document.documentElement.toggleAttribute('data-line-numbers', prefs.lineNumbers)
  style.setProperty('--column-width', prefs.columnWidth + 'px')
  style.setProperty('--side-margin', prefs.sideMargin + 'px')
  applyToolbar(prefs.hiddenTools)
  localStorage.setItem('reading', JSON.stringify(prefs))
}
export function languageOptions(): [string, string][] {
  return WRITING_LANGUAGES.map(([code, name]) => [code, name])
}
export function dialogHeader(dialog: HTMLDialogElement, title: string) {
  const head = element('div', 'dialog-head')
  const heading = element('h2', '', title)
  heading.id = 'dialog-title'
  const close = button('', () => dialog.close(), 'icon-button', 'close')
  close.setAttribute('aria-label', 'Close dialog')
  head.append(heading, close)
  return head
}
// Settings is one window with a section per subject, chosen from the list on the left.
export type SettingsSection = 'appearance' | 'writing' | 'project' | 'author' | 'websites' | 'about'
const SECTIONS: [SettingsSection, string][] = [
  ['appearance', 'Appearance'], ['writing', 'Writing'], ['project', 'Project'], ['author', 'Author'], ['websites', 'Websites'], ['about', 'About']
]
// The section shown last opens again, until Tinto quits.
let lastSection: SettingsSection = 'appearance'
export type SettingsPanels = Record<SettingsSection, HTMLElement> & { body: HTMLElement, theme: HTMLElement, text: HTMLElement }

export function group(parent: HTMLElement, label?: string) {
  const section = element('section', 'settings-group')
  if (label) section.append(element('h3', 'group-label', label))
  parent.append(section)
  return section
}
export function showSettings(dialog: HTMLDialogElement, prefs: Preferences, projectPath: string | null, section?: SettingsSection): SettingsPanels {
  const content = element('div', 'settings-body')
  const nav = element('div', 'settings-nav')
  nav.setAttribute('role', 'tablist')
  nav.setAttribute('aria-orientation', 'vertical')
  nav.setAttribute('aria-label', 'Settings sections')
  content.append(nav)
  const tabs = new Map<SettingsSection, HTMLButtonElement>()
  const panels = { body: content } as unknown as SettingsPanels
  for (const [id, name] of SECTIONS) {
    const tab = element('button', 'settings-tab', name)
    tab.type = 'button'
    tab.id = 'settings-tab-' + id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', 'settings-' + id)
    tab.onclick = () => show(id)
    const panel = element('div', 'settings-panel')
    panel.id = 'settings-' + id
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tab.id)
    nav.append(tab)
    content.append(panel)
    tabs.set(id, tab)
    panels[id] = panel
  }
  function show(id: SettingsSection, focus = false) {
    lastSection = id
    for (const [key, tab] of tabs) {
      const selected = key === id
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      panels[key].hidden = !selected
    }
    if (focus) tabs.get(id)!.focus()
  }
  // Arrow keys move between sections, as in any list of tabs.
  nav.onkeydown = event => {
    const order = SECTIONS.map(([id]) => id)
    const at = order.indexOf(lastSection)
    // The list is a row in narrow windows, so the side arrows also move.
    const next = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: order.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    show(order[(next + order.length) % order.length], true)
  }

  function field<T extends string>(parent: HTMLElement, label: string, options: [T, string][], current: T, change: (value: T) => void) {
    const row = element('label', 'field', label)
    const select = element('select')
    for (const [value, title] of options) select.add(new Option(title, value))
    select.value = current
    select.onchange = () => { change(select.value as T); applyPreferences(prefs) }
    row.append(select)
    parent.append(row)
    return select
  }
  function checkbox(parent: HTMLElement, label: string, key: 'lineNumbers' | 'markdownImports' | 'checkUpdates') {
    const row = element('label', 'field', label)
    const toggle = element('input')
    toggle.type = 'checkbox'
    toggle.checked = prefs[key]
    toggle.onchange = () => { prefs[key] = toggle.checked; applyPreferences(prefs) }
    row.append(toggle)
    parent.append(row)
  }

  // Appearance: the theme and how the manuscript's text is set. Theme and font
  // choices are added by typographySettings into these two groups.
  panels.theme = group(panels.appearance)
  field(panels.theme, 'Appearance', [['system','System'], ['light','Light'], ['dark','Dark']], prefs.appearance, value => { prefs.appearance = value })
  panels.text = group(panels.appearance, 'Text')
  field(panels.text, 'Manuscript font size', [17,19,21,23,25].map(size => [String(size), size + ' px']), String(prefs.size), value => { prefs.size = Number(value) })
  field(panels.text, 'Line spacing', [['1.5','Compact'], ['1.72','Regular'], ['1.95','Spacious']], String(prefs.leading), value => { prefs.leading = Number(value) })

  // Toolbar: which tools the document bar and the formatting bar show.
  const toolbar = group(panels.appearance, 'Toolbar')
  toolbar.append(element('p', 'settings-note', 'Hidden tools keep their keyboard shortcuts.'))
  for (const [bar, title] of [['document', 'Document bar'], ['formatting', 'Formatting bar']] as const) {
    toolbar.append(element('h4', 'toolbar-bar', title))
    for (const tool of TOOLS.filter(item => item.bar === bar)) {
      const row = element('label', 'field', tool.label), toggle = element('input')
      toggle.type = 'checkbox'
      toggle.checked = !prefs.hiddenTools.includes(tool.id)
      toggle.onchange = () => {
        prefs.hiddenTools = toolIds(toggle.checked ? prefs.hiddenTools.filter(id => id !== tool.id) : [...prefs.hiddenTools, tool.id])
        applyPreferences(prefs)
      }
      row.append(toggle); toolbar.append(row)
    }
  }

  // Writing: the page, imports and spelling.
  const page = group(panels.writing, 'Page')
  const widthRow = element('label', 'field')
  function showWidthValue() {
    const fixedColumn = prefs.textWidth === 'fixed-width'
    const key = fixedColumn ? 'columnWidth' : 'sideMargin'
    widthRow.textContent = fixedColumn ? 'Column width (px)' : 'Margin on each side (px)'
    const input = element('input')
    input.type = 'number'
    input.min = fixedColumn ? '1' : '0'
    input.required = true
    input.valueAsNumber = prefs[key]
    input.oninput = () => {
      if (!input.validity.valid) return
      prefs[key] = input.valueAsNumber
      applyPreferences(prefs)
    }
    input.onblur = () => { input.valueAsNumber = prefs[key] }
    widthRow.append(input)
  }
  field(page, 'Text width', [['fixed-width', 'Fixed Width'], ['fixed-margin', 'Fixed Margin']], prefs.textWidth, mode => {
    prefs.textWidth = mode
    showWidthValue()
  })
  showWidthValue()
  page.append(widthRow)
  checkbox(page, 'Show line numbers', 'lineNumbers')
  checkbox(group(panels.writing, 'Importing'), 'Automatically activate markdown editing for imported .md files', 'markdownImports')
  const spelling = group(panels.writing, 'Spelling')
  field(spelling, 'Default spelling language', languageOptions(), prefs.defaultLanguage, value => { prefs.defaultLanguage = value }).name = 'default-language'

  // Project: where this project lives and how it is kept.
  if (projectPath) {
    group(panels.project, 'Project file').append(element('p', 'path', projectPath))
    group(panels.project, 'Version history').append(element('p', '', 'Tinto snapshots changed work every five minutes. Automatic versions are kept for 30 days. Named versions stay until you delete them.'))
  } else panels.project.append(element('p', 'settings-note', 'Open a project to see its file, version history and backup.'))

  // About: the version, and whether Tinto looks for a newer one when it opens.
  const about = group(panels.about, 'Tinto ' + window.tinto.version)
  checkbox(about, 'Check for new versions when Tinto opens and once a day', 'checkUpdates')
  about.append(element('p', 'settings-note', 'When Tinto opens, and then once a day while it stays open, it asks GitHub for the latest release and tells you when there is a newer one. Nothing from your projects is sent. You install a new version from its download; Tinto does not replace itself.'))
  group(panels.about, 'License').append(element('p', '', 'Tinto is released under the MIT license. It includes pandoc (GNU GPL 2 or later) and other open-source software; see NOTICE.md in the app and on GitHub.'))

  dialog.replaceChildren(dialogHeader(dialog, 'Settings'), content)
  show(section ?? lastSection)
  if (!dialog.open) dialog.showModal()
  return panels
}
