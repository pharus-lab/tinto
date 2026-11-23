import { button, element } from './ui'
import { THEMES, fontStack } from './typography'
import type { DictionaryPack } from './dictionary-packs'

export interface Preferences {
  appearance: string
  theme: string
  font: string
  size: number
  leading: number
  lineNumbers: boolean
  markdownImports: boolean
  textWidth: 'fixed-width' | 'fixed-margin'
  columnWidth: number
  sideMargin: number
  defaultLanguage: string
}
export function preferences(): Preferences {
  const saved = JSON.parse(localStorage.getItem('reading') ?? '{}')
  return {
    appearance: 'system', theme: 'tinto', font: 'book', size: 21, leading: 1.72, defaultLanguage: 'en',
    columnWidth: 680, sideMargin: 48, lineNumbers: false, markdownImports: false, ...saved,
    // A centered column of about 66 characters, unless the writer chose margins.
    textWidth: saved?.textWidth === 'fixed-margin' ? 'fixed-margin' : 'fixed-width'
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
  localStorage.setItem('reading', JSON.stringify(prefs))
}
export function languageOptions(packs: DictionaryPack[]): [string, string][] {
  return [['en', 'English'], ['es', 'Spanish'], ...packs.filter(pack => pack.installed).map(pack => [pack.code, pack.name] as [string, string])]
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
export function updateSettingsPacks(content: HTMLElement, packs: DictionaryPack[], defaultLanguage: string) {
  const language = content.querySelector<HTMLSelectElement>('[name=default-language]')!
  language.replaceChildren(...languageOptions(packs).map(([code, name]) => new Option(name, code)))
  language.value = defaultLanguage
  const available = content.querySelector<HTMLSelectElement>('[name=dictionary]')!
  available.replaceChildren(...packs.filter(pack => !pack.installed).map(pack => new Option(pack.name, pack.code)))
  available.closest<HTMLElement>('.dictionary-picker')!.hidden = !available.length
}

// Settings is one window with a section per subject, chosen from the list on the left.
export type SettingsSection = 'appearance' | 'writing' | 'project' | 'author' | 'websites'
const SECTIONS: [SettingsSection, string][] = [
  ['appearance', 'Appearance'], ['writing', 'Writing'], ['project', 'Project'], ['author', 'Author'], ['websites', 'Websites']
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
export function showSettings(dialog: HTMLDialogElement, prefs: Preferences, projectPath: string | null, packs: DictionaryPack[], install: (language: string) => Promise<void>, section?: SettingsSection): SettingsPanels {
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
  function checkbox(parent: HTMLElement, label: string, key: 'lineNumbers' | 'markdownImports') {
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
  field(spelling, 'Default spelling language', [], prefs.defaultLanguage, value => { prefs.defaultLanguage = value }).name = 'default-language'
  const picker = element('div', 'dictionary-picker')
  const row = element('label', 'field', 'More dictionaries')
  const select = element('select')
  select.name = 'dictionary'
  select.ariaLabel = 'Available dictionaries'
  row.append(select)
  const message = element('p', 'settings-note')
  message.setAttribute('role', 'alert')
  const download = button('Download dictionary', async () => {
    message.textContent = ''
    select.disabled = true
    download.disabled = true
    download.textContent = 'Downloading…'
    try { await install(select.value) }
    catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
    finally { select.disabled = false; download.disabled = false; download.textContent = 'Download dictionary' }
  }, 'outline')
  const actions = element('div', 'field-actions')
  actions.append(download)
  picker.append(row, actions)
  spelling.append(picker, message)
  updateSettingsPacks(content, packs, prefs.defaultLanguage)

  // Project: where this project lives and how it is kept.
  if (projectPath) {
    group(panels.project, 'Project file').append(element('p', 'path', projectPath))
    group(panels.project, 'Version history').append(element('p', '', 'Tinto snapshots changed work every five minutes. Automatic versions are kept for 30 days. Named versions stay until you delete them.'))
  } else panels.project.append(element('p', 'settings-note', 'Open a project to see its file, version history and backup.'))

  dialog.replaceChildren(dialogHeader(dialog, 'Settings'), content)
  show(section ?? lastSection)
  if (!dialog.open) dialog.showModal()
  return panels
}
