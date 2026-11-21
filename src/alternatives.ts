import { Plugin, TextSelection } from 'prosemirror-state'
import { type ChoiceContext, WritingEditor } from './editor'
import { newBlock } from './model'
import { attachMenu, button, contextMenu, element, icon } from './ui'

function panelButton(label: string, className: string, key: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.dataset.panelKey = key
  // Clicking a panel control must leave the writing selection available.
  // Keyboard users can still tab onto each control and activate it with Space.
  button.onmousedown = event => event.preventDefault()
  button.onclick = action
  return button
}

function editWording(row: HTMLElement, editor: WritingEditor, groupId: string, option: ChoiceContext['options'][number], onReview: (id: string) => void) {
  const dialog = element('dialog', 'alt-editor')
  dialog.setAttribute('aria-label', 'Edit wording')
  const prose = element('div', 'alt-editor-prose')
  const notice = element('div', 'alt-editor-notice')
  notice.setAttribute('role', 'status')
  const block = newBlock()
  block.content = option.content
  const draft = new WritingEditor(prose, { type: 'doc', content: [block] }, {
    message(message) { notice.textContent = message },
    plugins: [new Plugin({ filterTransaction(tr) {
      if (tr.doc.childCount === 1) return true
      notice.textContent = 'Keep this wording in one paragraph.'
      return false
    } })]
  })
  const original = draft.view.state.doc
  draft.view.dom.setAttribute('aria-label', 'Option wording')
  function save() {
    dialog.close()
    if (!draft.view.state.doc.eq(original)) {
      editor.editOption(groupId, option.id, draft.json().content[0].content ?? [])
      onReview(groupId)
    }
  }
  const actions = element('div', 'alt-editor-actions')
  actions.append(button('Cancel', () => dialog.close()), button('Save wording', save, 'primary'))
  dialog.append(prose, notice, actions)
  dialog.onclose = () => { draft.destroy(); dialog.remove() }
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dialog.close()
    } else if (event.key === 'Enter' && prose.contains(event.target as Node)) {
      event.preventDefault()
      event.stopPropagation()
      save()
    }
  }, true)
  const box = row.getBoundingClientRect()
  document.body.append(dialog)
  dialog.style.width = box.width + 'px'
  dialog.style.left = box.left + 'px'
  dialog.showModal()
  const top = Math.max(4, Math.min(box.top, innerHeight - dialog.offsetHeight - 4))
  dialog.style.top = top + 'px'
  dialog.style.maxHeight = `calc(100vh - ${top + 4}px)`
  draft.view.dispatch(draft.view.state.tr.setSelection(TextSelection.create(original, 1, original.content.size - 1)))
  draft.view.focus()
}

export function renderAlternatives(host: HTMLElement, editor: WritingEditor, groupId: string | null, onReview: (id: string) => void) {
  const focus = document.activeElement
  const focusKey = focus instanceof HTMLElement && host.contains(focus) ? focus.dataset.panelKey : undefined
  const selected = groupId ? editor.context(groupId) : null
  const contents = document.createDocumentFragment()
  const menu = contextMenu()

  function groupSection(group: ChoiceContext, nested: boolean): HTMLElement {
    const label = nested ? 'Within this passage' : 'Passage'
    const current = group.options.findIndex(option => option.id === group.active) + 1
    const section = document.createElement('section')
    section.className = nested ? 'alt-group alt-nested' : 'alt-group'
    section.setAttribute('aria-label', label)
    const header = document.createElement('div')
    header.className = 'alt-group-header'
    const title = document.createElement('h3')
    title.className = 'alt-heading'
    title.textContent = label
    const pagination = document.createElement('div')
    pagination.className = 'alt-pagination'
    const count = document.createElement('span')
    count.className = 'alt-count'
    count.textContent = current + ' of ' + group.options.length
    function arrow(direction: number) {
      const action = direction < 0 ? 'Previous' : 'Next'
      const button = panelButton(direction < 0 ? '‹' : '›', 'alt-arrow', group.id + action, () => {
        // Switching a parent can hide the child we were reviewing.
        onReview(group.id)
        editor.cycle(group.id, direction)
      })
      const name = action + (nested ? ' nested wording' : ' passage wording')
      button.setAttribute('aria-label', name)
      button.title = name
      return button
    }
    pagination.append(arrow(-1), count, arrow(1))
    header.append(title, pagination)
    const options = document.createElement('div')
    options.className = 'alt-options'
    for (const option of group.options) {
      const chosen = option.id === group.active
      const button = panelButton('', 'alt-option', option.id, () => {
        onReview(group.id)
        editor.choose(group.id, option.id)
      })
      button.setAttribute('aria-pressed', String(chosen))
      const check = document.createElement('span')
      check.className = 'alt-check'
      check.setAttribute('aria-hidden', 'true')
      check.textContent = chosen ? '✓' : ''
      const text = document.createElement('span')
      text.className = 'alt-wording'
      text.textContent = option.text || '(Empty wording)'
      button.append(check, text)
      const row = element('div', 'alt-option-row')
      const edit = () => editWording(row, editor, group.id, option, onReview)
      const pencil = panelButton('', 'alt-pencil', option.id + 'edit', edit)
      pencil.title = 'Edit this wording in the sidebar'
      pencil.setAttribute('aria-label', 'Edit ' + (option.text || 'empty wording') + ' in sidebar')
      pencil.append(icon('pencil'))
      attachMenu(button, menu, option.text || 'empty wording', [['Edit wording', edit], ['Delete wording', () => editor.deleteOption(group.id, option.id)]])
      row.append(button, pencil)
      options.append(row)
    }

    const actions = document.createElement('div')
    actions.className = 'alt-actions'
    actions.append(
      panelButton('Edit in manuscript', 'alt-edit', group.id + 'edit', () => {
        onReview(group.id)
        editor.selectOptionText(group.id)
      }),
      panelButton('Add option', 'alt-add', group.id + 'add', () => {
        editor.addOption(group.id)
        onReview(group.id)
      })
    )
    section.append(header, options, actions)
    return section
  }

  if (selected) {
    const parent = selected.parentId ? editor.context(selected.parentId) : null
    const passage = parent ?? selected
    if (passage.parentId) {
      const parentId = passage.parentId
      contents.append(panelButton('← Parent passage', 'alt-parent', 'parent', () => onReview(parentId)))
    }
    contents.append(groupSection(passage, false))
    for (const child of passage.children) {
      const context = editor.context(child.id)
      if (!context) continue
      contents.append(groupSection(context, true))
      if (context.children.length) {
        contents.append(panelButton('Open nested choices', 'alt-parent', context.id + 'children', () => onReview(context.children[0].id)))
      }
    }
  } else {
    const hint = document.createElement('p')
    hint.className = 'alt-empty'
    hint.textContent = 'Select wording in the manuscript to give it an alternative.'
    const add = panelButton('Add alternative', 'alt-add', 'selection', () => {
      const id = editor.addAlternative()
      if (id) onReview(id)
    })
    contents.append(hint, add)
  }

  host.replaceChildren(contents, menu)
  if (focusKey) {
    const replacement = Array.from(host.querySelectorAll('button')).find(button => button.dataset.panelKey === focusKey)
    ;(replacement ?? host.querySelector('button'))?.focus({ preventScroll: true })
  }
}
