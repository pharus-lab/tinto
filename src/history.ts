import type { ChoiceJSON, InlineJSON, Manuscript } from './model'
import { markTags, visibleText } from './model'
import type { DocumentRecord, Version } from './project-types'
import { button, element } from './ui'

export function optionList(group: ChoiceJSON): HTMLOListElement {
  const list = element('ol')
  for (const option of group.attrs.options) {
    const chosen = option.id === group.attrs.active
    const content = (chosen ? group.content : option.content) ?? []
    const item = element('li', '', chosen ? 'Chosen · ' : '')
    item.append(content.length ? formattedText(content) : '(Empty wording)')
    for (const child of content) {
      if (child.type === 'choice') item.append(optionList(child))
    }
    list.append(item)
  }
  return list
}

export function formattedText(content: InlineJSON[]): DocumentFragment {
  const result = document.createDocumentFragment()
  for (const inline of content) {
    if (inline.type === 'choice') {
      result.append(formattedText(inline.content ?? []))
      continue
    }
    let node: Node = document.createTextNode(inline.text)
    for (const mark of inline.marks ?? []) {
      const container = element(markTags[mark.type])
      container.append(node)
      node = container
    }
    result.append(node)
  }
  return result
}

function versionPreview(manuscript: Manuscript): HTMLElement {
  const preview = element('article', 'version-text')
  preview.setAttribute('aria-label', 'Version preview')
  for (const block of manuscript.content) {
    const content = block.content ?? []
    const paragraph = element(block.type === 'heading' ? 'h4' : 'p')
    paragraph.append(formattedText(content))
    preview.append(paragraph)
    for (const group of content) {
      if (group.type !== 'choice') continue
      const details = element('details')
      details.append(element('summary', '', 'Alternatives for “' + (visibleText(group) || 'Empty wording') + '”'), optionList(group))
      preview.append(details)
    }
  }
  return preview
}

export function showHistory(dialog: HTMLDialogElement, doc: DocumentRecord, restored: (doc: DocumentRecord) => void, notice: (message: string) => void) {
  const content = element('section', 'history-body')
  const heading = element('header', 'dialog-head')
  const title = element('h2', '', 'Version history')
  title.id = 'dialog-title'
  const close = button('', () => dialog.close(), 'icon-button', 'close')
  close.setAttribute('aria-label', 'Close history')
  heading.append(title, close)
  const form = element('form', 'field')
  const name = element('input')
  name.type = 'text'
  name.required = true
  name.placeholder = 'Version name'
  name.setAttribute('aria-label', 'Version name')
  const save = element('button', 'outline', 'Name current version')
  save.type = 'submit'
  form.append(name, save)
  const list = element('div')
  list.setAttribute('aria-label', 'Saved versions')
  const layout = element('div', 'history-layout')
  const actions = element('div', 'dialog-actions')
  const status = element('p')
  status.setAttribute('role', 'status')
  const retention = element('p', '', 'Automatic versions are kept for 30 days. Named versions are kept until you delete them.')
  content.append(heading, element('p', '', doc.title), form, layout, actions, status, retention)
  dialog.replaceChildren(content)
  if (!dialog.open) dialog.showModal()
  let versions: Version[] = []
  let busy = false

  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true
    save.disabled = true
    actions.inert = true
    status.textContent = ''
    try {
      await action()
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
      actions.inert = false
      save.disabled = false
    }
  }

  function select(version: Version) {
    const time = (v: Version) => new Date(v.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    list.replaceChildren(...versions.map(item => {
      const entry = button(item.name ?? 'Automatic version', () => {
        select(item)
        list.querySelector<HTMLElement>('[aria-current="true"]')?.focus()
      }, 'version-entry')
      entry.setAttribute('aria-current', String(item.id === version.id))
      entry.append(element('small', '', time(item)))
      return entry
    }))
    layout.replaceChildren(list, versionPreview(version.manuscript))
    actions.replaceChildren()
    function confirmAction(question: string, label: string, action: () => Promise<void>) {
      const cancel = button('Cancel', () => select(version), 'outline')
      actions.replaceChildren(element('span', '', question), cancel, button(label, () => void run(action), 'primary'))
      cancel.focus()
    }
    if (version.name) {
      actions.append(button('Delete version', () => confirmAction('Delete this named version?', 'Delete', async () => {
        await window.tinto.deleteVersion(doc.id, version.id)
        await refresh()
      }), 'outline'))
    }
    actions.append(button('Restore version', () => confirmAction('Restore this version and save the current state in history?', 'Restore', async () => {
      const current = await window.tinto.restore(doc.id, version.id)
      restored(current)
      dialog.close()
      notice('Version restored.')
    }), 'primary'))
  }

  async function refresh() {
    versions = await window.tinto.versions(doc.id)
    if (versions.length) select(versions[0])
    else {
      layout.replaceChildren(element('p', '', 'No saved versions yet.'))
      actions.replaceChildren()
    }
  }

  form.onsubmit = event => {
    event.preventDefault()
    const value = name.value.trim()
    if (!value) { name.focus(); return }
    void run(async () => {
      await window.tinto.nameVersion(doc.id, value)
      name.value = ''
      await refresh()
      status.textContent = 'Version saved.'
    })
  }
  void run(refresh)
}
