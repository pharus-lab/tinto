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
  textWidth: 'fixed-width' | 'fixed-margin'
  columnWidth: number
  sideMargin: number
  defaultLanguage: string
}
export function preferences(): Preferences {
  const saved = JSON.parse(localStorage.getItem('reading') ?? '{}')
  return {
    appearance: 'system', theme: 'tinto', font: 'book', size: 21, leading: 1.72, defaultLanguage: 'en',
    columnWidth: 680, sideMargin: 48, lineNumbers: false, ...saved,
    textWidth: saved?.textWidth === 'fixed-width' ? 'fixed-width' : 'fixed-margin'
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
  available.parentElement!.hidden = !available.length
}
export function showSettings(dialog: HTMLDialogElement, prefs: Preferences, projectPath: string | null, packs: DictionaryPack[], install: (language: string) => Promise<void>) {
  const content = element('div', 'settings-body')
  function field<T extends string>(label: string, options: [T, string][], current: T, change: (value: T) => void) {
    const row = element('label', 'field', label)
    const select = element('select')
    for (const [value, title] of options) select.add(new Option(title, value))
    select.value = current
    select.onchange = () => { change(select.value as T); applyPreferences(prefs) }
    row.append(select)
    content.append(row)
    return select
  }
  field('Appearance', [['system','System'], ['light','Light'], ['dark','Dark']], prefs.appearance, value => { prefs.appearance = value })
  field('Manuscript font size', [17,19,21,23,25].map(size => [String(size), size + ' px']), String(prefs.size), value => { prefs.size = Number(value) })
  field('Line spacing', [['1.5','Compact'], ['1.72','Regular'], ['1.95','Spacious']], String(prefs.leading), value => { prefs.leading = Number(value) })
  const numbers = element('label', 'field', 'Show line numbers')
  const toggle = element('input')
  toggle.type = 'checkbox'
  toggle.checked = prefs.lineNumbers
  toggle.onchange = () => { prefs.lineNumbers = toggle.checked; applyPreferences(prefs) }
  numbers.append(toggle)
  content.append(numbers)
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
  field('Text width', [['fixed-width', 'Fixed Width'], ['fixed-margin', 'Fixed Margin']], prefs.textWidth, mode => {
    prefs.textWidth = mode
    showWidthValue()
  })
  showWidthValue()
  content.append(widthRow)
  field('Default spelling language', [], prefs.defaultLanguage, value => { prefs.defaultLanguage = value }).name = 'default-language'
  const row = element('div', 'field')
  const select = element('select')
  select.name = 'dictionary'
  select.ariaLabel = 'Available dictionaries'
  const message = element('p')
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
  row.append(download, select)
  content.append(row, message)
  updateSettingsPacks(content, packs, prefs.defaultLanguage)
  if (projectPath) content.append(element('h3', 'group-label', 'Project file'), element('p', 'path', projectPath))
  content.append(element('h3', 'group-label', 'Version history'), element('p', '', 'Tinto snapshots changed work every five minutes. Automatic versions are kept for 30 days. Named versions stay until you delete them.'))
  dialog.replaceChildren(dialogHeader(dialog, 'Settings'), content)
  if (!dialog.open) dialog.showModal()
  return content
}
