import { Plugin } from 'prosemirror-state'
import { WritingEditor, type Format } from './editor'
import { renderAlternatives } from './alternatives'
import { formattedText, optionList } from './history'
import { visibleText, type BlockJSON, type ChoiceJSON, type InlineJSON } from './model'
import type { DraftChange, DraftResolution } from './project-types'
import { button, element } from './ui'

export interface DraftReviewOptions {
  sourceTitle: string
  draftTitle: string
  load(): Promise<DraftChange[]>
  apply(resolutions: DraftResolution[]): Promise<void>
  closed?(): void
}

function draftDialog(title: string, className: string) {
  const dialog = element('dialog', className)
  const header = element('header', 'dialog-head')
  const heading = element('h2', '', title)
  heading.id = crypto.randomUUID()
  dialog.setAttribute('aria-labelledby', heading.id)
  const close = button('', () => dialog.close(), 'icon-button', 'close')
  close.setAttribute('aria-label', 'Close ' + title.toLowerCase())
  header.append(heading, close)
  dialog.append(header)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  return dialog
}

export function createDraftDialog(suggestedName: string): Promise<string | null> {
  const dialog = draftDialog('Create independent draft', 'create-draft')
  const form = element('form')
  const field = element('label', 'field', 'Draft name')
  const name = element('input')
  name.type = 'text'
  name.value = suggestedName
  name.required = true
  field.append(name)
  const actions = element('div', 'dialog-actions')
  const create = element('button', 'primary', 'Create draft')
  create.type = 'submit'
  actions.append(button('Cancel', () => dialog.close(), 'outline'), create)
  form.append(field, actions)
  dialog.append(form)
  form.onsubmit = event => {
    event.preventDefault()
    if (!name.value.trim()) { name.focus(); return }
    dialog.close(name.value.trim())
  }
  dialog.showModal()
  name.select()
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true }))
}

function alternativeGroups(content: InlineJSON[], groups = new Map<string, ChoiceJSON>()): Map<string, ChoiceJSON> {
  for (const node of content) {
    if (node.type !== 'choice') continue
    groups.set(node.attrs.id, node)
    for (const option of node.attrs.options) alternativeGroups((option.id === node.attrs.active ? node.content : option.content) ?? [], groups)
  }
  return groups
}

function changedWording(original: BlockJSON | null, draft: BlockJSON | null): string[] {
  if (!original || !draft) return []
  const before = alternativeGroups(original.content ?? [])
  const after = alternativeGroups(draft.content ?? [])
  const notes: string[] = []
  for (const [id, group] of after) {
    const previous = before.get(id)
    if (!previous) continue
    const context = visibleText(group) || 'Empty wording'
    if (group.attrs.active !== previous.attrs.active) notes.push('Chosen option differs for “' + context + '”.')
    group.attrs.options.forEach((option, index) => {
      const old = previous.attrs.options.find(entry => entry.id === option.id)
      if (!old || option.id === group.attrs.active || old.id === previous.attrs.active) return
      if (JSON.stringify(old.content ?? []) !== JSON.stringify(option.content ?? [])) {
        notes.push('Hidden option ' + (index + 1) + ' differs for “' + context + '”.')
      }
    })
    if (group.attrs.options.length !== previous.attrs.options.length) notes.push('The number of options differs for “' + context + '”.')
  }
  if (!notes.length && before.size !== after.size) notes.push('The alternatives in this passage differ.')
  return notes
}

function passage(block: BlockJSON | null, label: string, showOptions: boolean): HTMLElement {
  const column = element('section', 'draft-column')
  column.setAttribute('aria-label', label)
  column.append(element('h4', '', label))
  if (!block) {
    column.append(element('p', 'draft-absent', 'No paragraph'))
    return column
  }
  const content = block.content ?? []
  if (block.type === 'heading') column.append(element('small', '', 'Heading ' + block.attrs.level))
  const preview = element('div', 'draft-prose' + (block.type === 'heading' ? ' draft-heading' : ''))
  preview.append(content.length ? formattedText(content) : '(Empty paragraph)')
  column.append(preview)
  for (const group of content) {
    if (group.type !== 'choice') continue
    const details = element('details', 'draft-options')
    details.open = showOptions
    details.append(element('summary', '', 'Alternatives for “' + (visibleText(group) || 'Empty wording') + '”'), optionList(group))
    column.append(details)
  }
  return column
}

type Outcome = '' | 'original' | 'draft' | 'edit-original' | 'edit-draft'
interface ReviewRow { revision: string; selected: boolean; outcome: Outcome; edited?: BlockJSON }

function resultEditor(host: HTMLElement, initial: BlockJSON, change: (block: BlockJSON) => void): WritingEditor {
  const tools = element('div', 'draft-edit-tools')
  const style = element('select')
  style.setAttribute('aria-label', 'Result paragraph style')
  style.add(new Option('Paragraph', 'paragraph'))
  for (let i = 1; i <= 6; i++) style.add(new Option('Heading ' + i, 'h' + i))
  style.value = initial.type === 'heading' ? 'h' + initial.attrs.level : 'paragraph'
  const prose = element('div', 'draft-result-prose')
  const choices = element('div', 'draft-result-options')
  const notice = element('div', 'draft-edit-notice')
  notice.setAttribute('role', 'status')
  let reviewed: string | null = null
  let panel = false
  const editor = new WritingEditor(prose, { type: 'doc', content: [initial] }, {
    change(doc) { change(doc.content[0]) },
    selection() {
      if (!panel) return
      reviewed = editor.context()?.id ?? null
      draw()
    },
    message(message) { notice.textContent = message },
    plugins: [new Plugin({ filterTransaction(tr) {
      if (tr.doc.childCount === 1) return true
      notice.textContent = 'Keep the merged result in one paragraph.'
      return false
    } })],
  })
  editor.view.dom.setAttribute('aria-label', 'Edited result')
  const alternatives = button('Alternatives', () => {
    panel = !panel
    reviewed = panel ? editor.context()?.id ?? null : null
    draw()
  }, 'outline')
  function draw() {
    alternatives.setAttribute('aria-expanded', String(panel))
    choices.hidden = !panel
    editor.review(panel ? reviewed : null)
    if (panel) renderAlternatives(choices, editor, reviewed, id => { reviewed = id; draw() })
  }
  style.onchange = () => editor.format(style.value as Format)
  tools.onmousedown = event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }
  tools.append(style, ...(['bold', 'italic', 'underline'] as const).map(mark => button(mark[0].toUpperCase() + mark.slice(1), () => editor.format(mark), 'outline')), alternatives)
  host.append(tools, prose, choices, notice)
  draw()
  return editor
}

export function showDraftReview(options: DraftReviewOptions): void {
  const dialog = draftDialog('Review draft', 'draft-review')
  const subtitle = element('p', 'draft-subtitle', options.sourceTitle + ' · ' + options.draftTitle)
  const list = element('div', 'draft-changes')
  const status = element('div', 'draft-review-status')
  status.setAttribute('role', 'status')
  const actions = element('div', 'dialog-actions draft-review-actions')
  const selected = button('Apply selected', () => void apply(false), 'outline')
  const all = button('Apply all', () => void apply(true), 'primary')
  actions.append(status, selected, all)
  dialog.append(subtitle, list, actions)
  dialog.showModal()
  let changes: DraftChange[] = []
  const rows = new Map<string, ReviewRow>()
  const editors = new Map<string, WritingEditor>()
  let busy = false

  function controls() {
    const count = changes.filter(item => rows.get(item.id)?.selected).length
    selected.disabled = busy || !count
    selected.textContent = 'Apply selected' + (count ? ' (' + count + ')' : '')
    all.disabled = busy || !changes.length
    list.inert = busy
  }

  function changeRow(item: DraftChange, index: number) {
    const side = item.origin === 'conflict' ? 'Conflict' : item.origin === 'original' ? 'Original' : 'Draft'
    const kind = [item.original, item.draft, item.baseline].find(Boolean)?.type === 'heading' ? 'heading' : 'paragraph'
    const verb = item.kind === 'modified' ? 'changed' : item.kind
    const title = kind[0].toUpperCase() + kind.slice(1) + ' ' + verb
    const article = element('article', 'draft-change')
    const row = rows.get(item.id)!
    const head = element('header', 'draft-row-head')
    const label = element('label')
    const checkbox = element('input')
    checkbox.type = 'checkbox'
    checkbox.checked = row.selected
    checkbox.setAttribute('aria-label', 'Include change ' + (index + 1))
    checkbox.onchange = () => { row.selected = checkbox.checked; controls() }
    label.append(checkbox, element('strong', '', title))
    head.append(label, element('span', 'draft-origin' + (item.origin === 'conflict' ? ' draft-conflict' : ''), side))
    const notes = changedWording(item.original, item.draft)
    const columns = element('div', 'draft-columns')
    columns.append(passage(item.original, 'Original', notes.length > 0), passage(item.draft, 'Independent draft', notes.length > 0))
    article.append(head, ...notes.map(note => element('p', 'draft-difference', note)), columns)
    const baseline = element('details', 'draft-baseline')
    baseline.append(element('summary', '', 'Last reconciled version'), passage(item.baseline, 'Baseline', false))
    article.append(baseline)
    const labelResult = element('label', 'draft-outcome', 'Result')
    const outcome = element('select')
    outcome.setAttribute('aria-label', 'Result')
    outcome.dataset.changeId = item.id
    if (item.origin === 'conflict') outcome.add(new Option('Choose a result', ''))
    outcome.add(new Option(item.original ? 'Keep original' : 'Keep original deletion', 'original'))
    outcome.add(new Option(item.draft ? 'Use draft' : 'Use draft deletion', 'draft'))
    if (item.original) outcome.add(new Option('Edit original wording…', 'edit-original'))
    if (item.draft) outcome.add(new Option('Edit draft wording…', 'edit-draft'))
    outcome.value = row.outcome
    labelResult.append(outcome)
    const editArea = element('div', 'draft-edit')
    function showEdited() {
      editors.get(item.id)?.destroy()
      editors.delete(item.id)
      editArea.replaceChildren()
      if (!row.outcome.startsWith('edit-')) return
      const initial = row.edited ?? (row.outcome === 'edit-original' ? item.original! : item.draft!)
      row.edited = initial
      editors.set(item.id, resultEditor(editArea, initial, block => { row.edited = block }))
    }
    outcome.onchange = () => {
      row.outcome = outcome.value as Outcome
      row.edited = undefined
      showEdited()
      status.textContent = ''
    }
    showEdited()
    article.append(labelResult, editArea)
    return article
  }

  async function refresh() {
    const next = await options.load()
    if (!dialog.open) return
    changes = next
    for (const editor of editors.values()) editor.destroy()
    editors.clear()
    for (const item of changes) {
      if (rows.get(item.id)?.revision === item.revision) continue
      rows.set(item.id, { revision: item.revision, selected: false, outcome: item.origin === 'conflict' ? '' : item.origin })
    }
    list.replaceChildren(...changes.map(changeRow))
    if (!changes.length) list.append(element('p', 'draft-no-changes', 'No pending changes.'))
    controls()
  }

  async function apply(applyAll: boolean) {
    if (busy) return
    const resolutions: DraftResolution[] = []
    for (const item of changes) {
      const row = rows.get(item.id)!
      if (!applyAll && !row.selected) continue
      if (!row.outcome) {
        status.textContent = 'Choose a result for each included conflict.'
        list.querySelector<HTMLElement>('[data-change-id="' + CSS.escape(item.id) + '"]')?.focus()
        return
      }
      const base = { id: item.id, revision: item.revision }
      if (row.outcome === 'original' || row.outcome === 'draft') resolutions.push({ ...base, choice: row.outcome })
      else resolutions.push({ ...base, choice: 'edited', block: row.edited })
    }
    if (!resolutions.length) return
    busy = true
    controls()
    try {
      await options.apply(resolutions)
      await refresh()
      status.textContent = resolutions.length === 1 ? 'Applied 1 change.' : 'Applied ' + resolutions.length + ' changes.'
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
      try { await refresh() } catch { /* Keep the comparison open for another attempt. */ }
    } finally {
      busy = false
      controls()
    }
  }

  dialog.addEventListener('close', () => {
    for (const editor of editors.values()) editor.destroy()
    options.closed?.()
  }, { once: true })
  controls()
  status.textContent = 'Loading changes…'
  void refresh().then(() => { status.textContent = '' }).catch(error => { status.textContent = error instanceof Error ? error.message : String(error) })
}
