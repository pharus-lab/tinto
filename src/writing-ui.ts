import type { EditorView } from 'prosemirror-view'
import { applyWriting, checkWriting, dismissWriting, ignoreWriting, retryWriting, selectWriting, writingIssues, writingKey, writingStatus, type WritingIssue, type WritingState } from './writing-checks'
import { sectionKey } from './section'
import { acceptWord, disableWritingRule } from './writing-preferences'
import { english, supportedWritingLanguage, validPersonalWord } from './writing-types'
import { button, element, errorMessage } from './ui'

const renders = new WeakMap<HTMLElement, { view: EditorView; scope: string; state: WritingState; shown: number }>()
const nodeIds = new WeakMap<WritingIssue['node'], number>()
let nextNodeId = 0
function issueId(issue: WritingIssue) {
  if (!nodeIds.has(issue.node)) nodeIds.set(issue.node, ++nextNodeId)
  return nodeIds.get(issue.node) + ':' + issue.key
}

export function renderWritingChecks(host: HTMLElement, view: EditorView, message: (text: string) => void) {
  const previous = renders.get(host), state = writingKey.getState(view.state)!, scopeId = sectionKey.getState(view.state)?.id ?? ''
  const sameView = previous?.view === view && previous.scope === scopeId
  const shown = sameView ? Math.max(50, Number(host.dataset.shown) || 50) : 50
  if (sameView && previous.state === state && previous.shown === shown) return
  const selected = new Map(sameView ? [...host.querySelectorAll<HTMLSelectElement>('select[data-writing-action]')].map(select => [select.dataset.writingAction, select.selectedOptions[0]?.dataset.replacement]) : [])
  const focus = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.writingAction : undefined
  const status = writingStatus(view.state), issues = writingIssues(view.state, true)
  renders.set(host, { view, scope: scopeId, state, shown })
  host.dataset.shown = String(shown)
  host.setAttribute('aria-busy', String(status.status === 'checking'))
  host.tabIndex = -1
  const unsupported = !supportedWritingLanguage(status.language)
  const actions = element('div', 'writing-actions')
  const again = button(unsupported ? 'Check writing' : status.status === 'error' ? 'Try again' : status.manual ? 'Check again' : 'Check writing', () => {
    if (status.status === 'error' && !status.manual) retryWriting(view)
    else checkWriting(view)
  }, 'outline')
  again.dataset.writingAction = 'check'
  again.disabled = unsupported || status.status === 'checking'
  actions.append(again)
  if (status.manual) {
    const dismiss = button('Dismiss results', () => dismissWriting(view), 'quiet')
    dismiss.dataset.writingAction = 'dismiss'; actions.append(dismiss)
  }
  const note = element('p', 'settings-note')
  note.setAttribute('role', 'status')
  note.textContent = unsupported ? 'Writing checks support English, English (UK), and Spanish. You can keep editing and saving this document in its original language.' : status.status === 'checking' ? 'Checking writing…' : status.status === 'error' ? 'Writing checks are unavailable. Try again.' : status.status === 'edited' ? 'Check again to include changes since the last check.' : status.status === 'ready' ? issues.length ? issues.length + (issues.length === 1 ? ' possible issue.' : ' possible issues.') : 'No issues found.' : status.enabled ? 'Checks appear after you pause typing.' : 'Check this document when you’re ready. Automatic checks are off.'
  const categories = unsupported ? '' : status.spelling && status.grammar ? 'English spelling and grammar' : status.grammar ? 'English grammar only' : status.spelling ? english(status.language) ? 'English spelling only' : 'Spelling only' : ''
  const scope = element('p', 'settings-note', categories ? categories + ' · chosen wording only' : 'Chosen wording only')
  host.replaceChildren(actions, note, scope)
  const list = element('div', 'writing-results')
  // Keep the sidebar usable for very long manuscripts. More results are
  // revealed on demand, without dropping any diagnostics or editor marks.
  for (const issue of issues.slice(0, shown)) {
    const index = issueId(issue)
    const { diagnostic: d } = issue
    const row = element('section', 'writing-result')
    row.setAttribute('aria-label', d.category + ': ' + d.source)
    const passage = button(d.source, () => selectWriting(view, issue), 'writing-passage')
    passage.title = 'Show passage in manuscript'
    passage.dataset.writingAction = 'passage:' + index
    row.append(passage, element('p', 'writing-explanation', d.message))
    if (d.replacements.length) {
      const replacement = element('select')
      replacement.setAttribute('aria-label', 'Proposed correction for ' + d.source)
      replacement.dataset.writingAction = 'replacement:' + index
      for (const [i, suggestion] of d.replacements.entries()) {
        const option = new Option(suggestion.text || 'Remove this text', String(i))
        option.dataset.replacement = JSON.stringify(suggestion)
        replacement.add(option)
        if (selected.get(replacement.dataset.writingAction) === option.dataset.replacement) replacement.value = String(i)
      }
      const controls = element('div', 'writing-replacement')
      const apply = button('Apply', () => { if (!applyWriting(view, issue, Number(replacement.value))) message('This passage has changed. Check again before applying a correction.') }, 'outline')
      apply.dataset.writingAction = 'apply:' + index
      apply.disabled = !!issue.manualReason
      controls.append(replacement, apply); row.append(controls)
    } else row.append(element('p', 'settings-note', 'No proposed correction. Edit this passage manually.'))
    if (issue.manualReason) row.append(element('p', 'settings-note', issue.manualReason))
    const controls = element('div', 'writing-actions')
    const ignore = button('Ignore', () => ignoreWriting(view, issue), 'quiet')
    ignore.dataset.writingAction = 'ignore:' + index; controls.append(ignore)
    if (d.category === 'Spelling' && validPersonalWord(d.source)) {
      const add = button('Add to personal dictionary', () => { try { acceptWord(status.language, d.source) } catch (error) { message(errorMessage(error)) } }, 'quiet')
      add.dataset.writingAction = 'dictionary:' + index; controls.append(add)
    } else if (d.category !== 'Spelling') {
      const disable = button('Disable this grammar rule', () => { try { disableWritingRule(d.rule) } catch (error) { message(errorMessage(error)) } }, 'quiet')
      disable.dataset.writingAction = 'disable:' + index; disable.title = d.rule; controls.append(disable)
    }
    row.append(controls); list.append(row)
  }
  host.append(list)
  if (issues.length > shown) {
    const more = button('Show more results', () => {
      // Continue keyboard review at the first newly revealed passage.
      more.dataset.writingAction = 'passage:' + issueId(issues[shown])
      host.dataset.shown = String(shown + 50); renderWritingChecks(host, view, message)
    }, 'outline')
    more.dataset.writingAction = 'more'; host.append(more)
  }
  if (focus) {
    const controls = [...host.querySelectorAll<HTMLElement>('[data-writing-action]:not(:disabled)')]
    const next = controls.find(el => el.dataset.writingAction === focus) ?? controls[0] ?? host
    next.focus({ preventScroll: true })
  }
}
