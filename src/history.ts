import { diffArrays } from 'diff'
import type { ChoiceJSON, InlineJSON, Manuscript, TextJSON } from './model'
import { comparableInlines, formatMarks, markTags, visibleText } from './model'
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
    for (const mark of formatMarks(inline.marks)) {
      const container = element(markTags[mark.type])
      container.append(node)
      node = container
    }
    result.append(node)
  }
  return result
}

function manuscriptLines(manuscript: Manuscript) {
  return manuscript.content.map((block, index) => {
    const content = comparableInlines(block.content)
    const signature = JSON.stringify([block.type, block.attrs.level, content])
    return { block, content, signature, number: index + 1 }
  })
}

type Line = ReturnType<typeof manuscriptLines>[number]
interface ChangeRow { current?: Line; past?: Line }

function changedLines(current: Line[], past: Line[]): ChangeRow[] {
  // Anchor unchanged text first. A split or paste can leave the paragraph
  // ID on a different line. Use that ID to pair genuinely edited passages.
  const oldContents = new Set(past.map(line => line.signature))
  const newContents = new Set(current.map(line => line.signature))
  const diff = diffArrays(past, current, { comparator: (oldLine, newLine) => {
    if (oldLine.signature === newLine.signature) return true
    return oldLine.block.attrs.id === newLine.block.attrs.id && !newContents.has(oldLine.signature) && !oldContents.has(newLine.signature)
  } })
  const rows: ChangeRow[] = []
  let currentIndex = 0
  let pastIndex = 0
  let added = 0
  let removed = 0

  function flushReplacements() {
    for (let i = 0; i < Math.max(added, removed); i++) {
      rows.push({ current: i < added ? current[currentIndex + i] : undefined, past: i < removed ? past[pastIndex + i] : undefined })
    }
    currentIndex += added
    pastIndex += removed
    added = removed = 0
  }

  for (const part of diff) {
    if (part.added) added += part.count
    else if (part.removed) removed += part.count
    else {
      flushReplacements()
      for (let i = 0; i < part.count; i++) {
        const left = current[currentIndex++]
        const right = past[pastIndex++]
        if (left.signature !== right.signature) rows.push({ current: left, past: right })
      }
    }
  }
  flushReplacements()
  return rows
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })
function wordTokens(content: InlineJSON[]): TextJSON[] {
  return content.flatMap(node => node.type === 'choice' ? wordTokens(node.content ?? []) :
    Array.from(words.segment(node.text), ({ segment }) => ({ ...node, text: segment })))
}

function lineCell(line: Line | undefined, prose: DocumentFragment, side: string, expandOptions: boolean) {
  const cell = element('td', 'history-cell ' + side)
  if (!line) {
    cell.setAttribute('aria-label', 'No corresponding line')
    return cell
  }
  const number = element('span', 'history-line-number', String(line.number))
  number.setAttribute('aria-label', 'Line ' + line.number)
  const body = element('div', 'history-passage')
  const paragraph = element('div', 'history-prose')
  if (line.block.type === 'heading') body.append(element('small', 'history-block-style', 'Heading ' + (line.block.attrs.level ?? 1)))
  paragraph.append(prose.hasChildNodes() ? prose : element('em', 'history-empty-line', 'Empty paragraph'))
  body.append(paragraph)
  for (const group of line.content) {
    if (group.type !== 'choice') continue
    const details = element('details')
    details.open = expandOptions
    details.append(element('summary', '', 'Alternatives for “' + (visibleText(group) || 'Empty wording') + '”'), optionList(group))
    body.append(details)
  }
  cell.append(number, body)
  return cell
}

function comparison(current: Line[], version: Version) {
  const rows = changedLines(current, manuscriptLines(version.manuscript))
  const view = element('div', 'history-comparison')
  const table = element('table', 'version-text')
  table.setAttribute('aria-label', 'Changed passages')
  const header = table.createTHead().insertRow()
  header.append(element('th', '', 'Current version'), element('th', '', 'Saved version'))
  const body = table.createTBody()
  for (const { current, past } of rows) {
    const left = document.createDocumentFragment()
    const right = document.createDocumentFragment()
    const before = wordTokens(past?.content ?? [])
    const after = wordTokens(current?.content ?? [])
    const parts = diffArrays(before, after, { comparator: (a, b) => a.text === b.text && JSON.stringify(a.marks) === JSON.stringify(b.marks) })
    for (const part of parts) {
      const prose = formattedText(comparableInlines(part.value))
      if (part.added || part.removed) {
        const mark = element(part.added ? 'ins' : 'del')
        mark.append(prose)
        const side = part.added ? left : right
        side.append(mark)
      } else {
        left.append(prose.cloneNode(true))
        right.append(prose)
      }
    }
    const optionsOnly = !!current && !!past && parts.every(part => !part.added && !part.removed)
    const row = body.insertRow()
    row.append(lineCell(current, left, 'current', optionsOnly), lineCell(past, right, 'past', optionsOnly))
  }
  view.append(table)
  if (!rows.length) view.append(element('p', 'history-empty', 'No changes since this version.'))
  return view
}

export function showHistory(dialog: HTMLDialogElement, doc: DocumentRecord, restored: (doc: DocumentRecord) => void, notice: (message: string) => void) {
  const current = manuscriptLines(doc.manuscript)
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
  const controls = element('div', 'history-controls')
  const list = element('select')
  list.setAttribute('aria-label', 'Saved version')
  const expand = button('Open in separate window', () => openComparison(), 'outline')
  controls.append(list, expand)
  controls.hidden = true
  const layout = element('div', 'history-layout')
  const actions = element('div', 'dialog-actions')
  const status = element('p')
  status.setAttribute('role', 'status')
  const retention = element('p', '', 'Automatic versions are kept for 30 days. Named versions are kept until you delete them.')
  content.append(heading, element('p', 'history-title', doc.title), controls, layout, actions, form, status, retention)
  dialog.replaceChildren(content)
  if (!dialog.open) dialog.showModal()
  let versions: Version[] = []
  let busy = false
  let expanded: Window | null = null

  function drawExpanded() {
    if (!expanded || expanded.closed) return
    const picker = list.cloneNode(true) as HTMLSelectElement
    picker.value = list.value
    picker.onchange = () => {
      select(versions[picker.selectedIndex])
      expanded?.document.querySelector('select')?.focus()
    }
    const head = element('header', 'history-controls')
    head.append(element('h1', '', doc.title), picker)
    expanded.document.body.replaceChildren(head, layout.firstElementChild!.cloneNode(true))
  }

  function openComparison() {
    if (!expanded || expanded.closed) {
      expanded = window.open('about:blank', 'tinto-history', 'popup,width=1120,height=800')
      if (!expanded) { status.textContent = 'Could not open the comparison window.'; return }
      const page = expanded.document
      page.title = doc.title + ' — Version history'
      page.documentElement.lang = document.documentElement.lang
      Object.assign(page.documentElement.dataset, document.documentElement.dataset)
      page.documentElement.style.cssText = document.documentElement.style.cssText
      const css = element('link')
      css.rel = 'stylesheet'
      css.href = new URL('styles.css', document.baseURI).href
      page.head.append(css)
      const fonts = document.getElementById('manuscript-fonts')
      if (fonts) page.head.append(fonts.cloneNode(true))
      page.body.className = 'history-window'
      drawExpanded()
    }
    expanded.focus()
  }

  dialog.addEventListener('close', () => expanded?.close(), { once: true })
  list.onchange = () => select(versions[list.selectedIndex])

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
    list.value = version.id
    layout.replaceChildren(comparison(current, version))
    drawExpanded()
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
    list.replaceChildren(...versions.map(version => {
      const time = new Date(version.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      return new Option((version.name ?? 'Automatic version') + ' · ' + time, version.id)
    }))
    controls.hidden = !versions.length
    if (versions.length) select(versions[0])
    else {
      expanded?.close()
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
