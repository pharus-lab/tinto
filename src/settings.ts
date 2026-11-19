import { button, element, icon } from './ui'
import type { DictionaryPack } from './dictionary-packs'

export interface Preferences { appearance: string; size: number; leading: number; defaultLanguage: string }
export function preferences(): Preferences {
  return { appearance: 'system', size: 21, leading: 1.72, defaultLanguage: 'en', ...JSON.parse(localStorage.getItem('reading') ?? '{}') }
}
export function applyPreferences(prefs: Preferences) {
  const style = document.documentElement.style
  style.colorScheme = prefs.appearance === 'system' ? 'light dark' : prefs.appearance
  style.setProperty('--size', prefs.size + 'px')
  style.setProperty('--leading', String(prefs.leading))
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
export function newDocumentDialog(dialog: HTMLDialogElement, create: (title: string) => void) {
  const form = element('form')
  const label = element('label', 'field', 'Document title')
  const name = element('input')
  name.type = 'text'
  name.required = true
  name.autofocus = true
  label.append(name)
  const actions = element('div', 'dialog-actions')
  const submit = element('button', 'primary', 'Create document')
  submit.type = 'submit'
  actions.append(button('Cancel', () => dialog.close(), 'outline'), submit)
  form.append(label, actions)
  form.onsubmit = event => {
    event.preventDefault()
    if (!name.value.trim()) return
    create(name.value.trim())
    dialog.close()
  }
  dialog.replaceChildren(dialogHeader(dialog, 'New document'), form)
  dialog.showModal()
  name.focus()
}

export function showSettings(dialog: HTMLDialogElement, prefs: Preferences, projectPath: string | null, packs: DictionaryPack[], install: (language: string) => Promise<void>) {
  const content = element('div')
  function field(label: string, options: [string, string][], current: string, change: (value: string) => void) {
    const row = element('label', 'field', label)
    const select = element('select')
    for (const [value, title] of options) select.add(new Option(title, value))
    select.value = current
    select.onchange = () => { change(select.value); applyPreferences(prefs) }
    row.append(select)
    content.append(row)
  }
  field('Appearance', [['system','System'], ['light','Light'], ['dark','Dark']], prefs.appearance, value => { prefs.appearance = value })
  field('Manuscript font size', [17,19,21,23,25].map(size => [String(size), size + ' px']), String(prefs.size), value => { prefs.size = Number(value) })
  field('Line spacing', [['1.5','Compact'], ['1.72','Regular'], ['1.95','Spacious']], String(prefs.leading), value => { prefs.leading = Number(value) })
  field('Default spelling language', languageOptions(packs), prefs.defaultLanguage, value => { prefs.defaultLanguage = value })
  const downloadable = packs.filter(pack => !pack.installed)
  if (downloadable.length) {
    const row = element('div', 'field')
    const select = element('select')
    select.ariaLabel = 'Available dictionaries'
    for (const pack of downloadable) select.add(new Option(pack.name, pack.code))
    const download = button('Download dictionary', async () => {
      download.disabled = true
      download.textContent = 'Downloading…'
      try { await install(select.value) }
      finally { download.disabled = false; download.textContent = 'Download dictionary' }
    }, 'outline')
    row.append(download, select)
    content.append(row)
  }
  if (projectPath) content.append(element('h3', 'group-label', 'Project file'), element('p', 'path', projectPath))
  content.append(element('h3', 'group-label', 'Version history'), element('p', '', 'Tinto snapshots changed work every five minutes. Automatic versions are kept for 30 days. Named versions stay until you delete them.'))
  dialog.replaceChildren(dialogHeader(dialog, 'Settings'), content)
  if (!dialog.open) dialog.showModal()
}
