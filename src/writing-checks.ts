import type { Node } from 'prosemirror-model'
import { closeHistory } from 'prosemirror-history'
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { findSection, sectionKey } from './section'
import { writingProse, proseRanges, manualCorrectionReason, replaceProse, type Prose } from './writing-prose'
import { acceptWord, disableWritingRule, type WritingPreferences } from './writing-preferences'
import { dictionaryLanguage, english, normalizedWord, supportedWritingLanguage, validPersonalWord, WRITING_BATCH_LIMIT, WRITING_BLOCK_LIMIT, type WritingDiagnostic, type WritingFailure, type WritingRequest, type WritingResponse } from './writing-types'
import { COACH_LABELS, COACH_LIMIT, COACH_RESOLVED, findPassage, type AnchoredNote, type CoachRequest, type CoachResult, type ResolvedNote } from './writing-coach'
import { clearCoach, loadCoach, saveCoachResolved, saveCoachScope, type StoredCheck } from './coach-store'
import { errorMessage } from './ui'

type Status = 'idle' | 'checking' | 'ready' | 'edited' | 'error'
interface BlockCheck { node: Node; diagnostics: WritingDiagnostic[] }
interface ManualCheck { blocks: BlockCheck[]; status: Status; error?: WritingFailure }
interface Ignored { node: Node; key: string }
// A writing coach note in the manuscript. from and to are document positions
// that follow every edit; original is the passage's text when it was placed,
// to tell an edited passage (changed keeps that across a Markdown switch).
// anchored is false once the passage is gone: the note stays, unmarked.
export interface CoachNoteAt { id: string; note: AnchoredNote; from: number; to: number; original: string; anchored: boolean; changed?: boolean }
// A note the writer marked solved or dismissed; the next review takes it into account.
export interface CoachResolved extends CoachNoteAt { outcome: 'solved' | 'dismissed'; scope: string; at: string }
// A writing coach review of one scope. Its notes stay until Check again
// replaces them or the writer resolves them. stale: the scope changed since the
// review; checked holds the blocks sent (empty for notes restored from storage).
interface CoachCheck { token: number; status: 'checking' | 'ready' | 'error'; stale: boolean; checked: Node[]; notes: CoachNoteAt[]; dropped: number; provider?: string; model?: string; error?: string; reviewed?: string }
export interface WritingState {
  language: string
  markdown: boolean
  preferences: WritingPreferences
  revision: number
  automatic: BlockCheck[]
  manual: Map<string, ManualCheck>
  ignored: Ignored[]
  coach: Map<string, CoachCheck>
  coachResolved: CoachResolved[]
  autoStatus: Status
  error?: WritingFailure
}
export interface CoachIssue { id: string; note: AnchoredNote; from: number; to: number; anchored: boolean; edited: boolean }
export interface WritingIssue {
  node: Node
  offset: number
  prose: Prose
  diagnostic: WritingDiagnostic
  key: string
  manualReason: string | null
}
type WritingMeta =
  | { type: 'configure'; language?: string; markdown?: boolean; preferences?: WritingPreferences; reset?: boolean }
  | { type: 'view'; source: WritingState; fromDoc: Node; markdown: boolean }
  | { type: 'manual'; coach?: boolean }
  | { type: 'dismiss' | 'retry' }
  | { type: 'coach-results'; scope: string; token: number; notes: { node: Node; start: number; note: AnchoredNote }[]; dropped: number; provider?: string; model?: string; error?: string }
  | { type: 'coach-resolve'; id: string; outcome: 'solved' | 'dismissed' }
  | { type: 'started'; revision: number }
  | { type: 'ignore'; node: Node; key: string }
  | { type: 'results'; revision: number; manual: boolean; blocks: BlockCheck[]; done: boolean; error?: WritingFailure }
export const writingKey = new PluginKey<WritingState>('tintoWritingChecks')
const scopeOf = (state: EditorState) => sectionKey.getState(state)?.id ?? ''
const diagnosticKey = (d: WritingDiagnostic) => JSON.stringify([d.from, d.to, d.rule, d.source])
const liveEnabled = (state: WritingState) => supportedWritingLanguage(state.language) && (state.preferences.spelling || (state.preferences.grammar && english(state.language)))

function permitted(d: WritingDiagnostic, state: WritingState) {
  if (state.preferences.disabledRules.includes(d.rule)) return false
  return d.category !== 'Spelling' || !(state.preferences.words[dictionaryLanguage(state.language)] ?? []).some(word => normalizedWord(word) === normalizedWord(d.source))
}
function scopedBlocks(state: EditorState) {
  const section = sectionKey.getState(state)
  const blocks: { node: Node; offset: number }[] = []
  state.doc.forEach((node, offset) => { if (!section || (offset >= section.from && offset < section.to)) blocks.push({ node, offset }) })
  return blocks
}
export function writingIssues(state: EditorState, sidebar = false): WritingIssue[] {
  const value = writingKey.getState(state)
  if (!value) return []
  const manual = value.manual.get(scopeOf(state))
  const checks = sidebar && manual ? manual.blocks : [...(manual?.blocks ?? []), ...value.automatic]
  if (!checks.length) return []
  const byNode = new Map<Node, WritingDiagnostic[]>()
  for (const check of checks) byNode.set(check.node, [...(byNode.get(check.node) ?? []), ...check.diagnostics])
  const issues: WritingIssue[] = []
  for (const { node, offset } of scopedBlocks(state)) {
    const diagnostics = byNode.get(node)
    if (!diagnostics?.length) continue
    const seen = new Set<string>(), prose = writingProse(node, value.markdown)
    for (const diagnostic of diagnostics) {
      const key = diagnosticKey(diagnostic)
      if (seen.has(key) || !permitted(diagnostic, value) || value.ignored.some(item => item.node === node && item.key === key)) continue
      seen.add(key)
      issues.push({ node, offset, prose, diagnostic, key, manualReason: manualCorrectionReason(prose, diagnostic) })
    }
  }
  return issues.sort((a, b) => a.offset - b.offset || a.diagnostic.from - b.diagnostic.from)
}
export function writingStatus(state: EditorState) {
  const value = writingKey.getState(state)!
  const manual = value.manual.get(scopeOf(state))
  return { status: manual?.status ?? value.autoStatus, error: manual ? manual.error : value.error, manual: !!manual, enabled: liveEnabled(value), language: value.language,
    spelling: !!manual || value.preferences.spelling, grammar: english(value.language) && (!!manual || value.preferences.grammar) }
}
let noteIds = 0
const newNoteId = () => Date.now().toString(36) + '-' + (++noteIds).toString(36)
// The manuscript range of prose offsets in one block.
function blockRange(node: Node, offset: number, markdown: boolean, from: number, to: number) {
  const ranges = proseRanges(writingProse(node, markdown), from, to)
  return ranges.length ? { from: offset + ranges[0].from, to: offset + ranges.at(-1)!.to } : null
}
// The prose a writer sees between two document positions.
function proseText(doc: Node, markdown: boolean, from: number, to: number) {
  let text = ''
  doc.forEach((node, offset) => {
    if (offset + node.nodeSize <= from || offset >= to) return
    const prose = writingProse(node, markdown)
    for (let i = 0; i < prose.text.length; i++) {
      const at = offset + prose.positions[i]
      if (prose.positions[i] >= 0 && at >= from && at < to) text += prose.text[i]
    }
  })
  return text
}
// Find a quoted passage again, nearest a position: in its block first, then
// in the rest of the scope.
export function anchorPassage(doc: Node, markdown: boolean, quote: string, near: number, within?: { from: number; to: number } | null) {
  const blocks: { node: Node; offset: number; distance: number }[] = []
  doc.forEach((node, offset) => {
    if (within && (offset < within.from || offset >= within.to)) return
    blocks.push({ node, offset, distance: near >= offset && near < offset + node.nodeSize ? 0 : Math.min(Math.abs(offset - near), Math.abs(offset + node.nodeSize - near)) })
  })
  for (const { node, offset } of blocks.sort((a, b) => a.distance - b.distance)) {
    const found = findPassage(writingProse(node, markdown).text, quote, Math.max(0, near - offset))
    const range = found && blockRange(node, offset, markdown, found.from, found.to)
    if (range) return range
  }
  return null
}
const passageText = (doc: Node, from: number, to: number) => doc.textBetween(from, to, '\n')
// The coach's notes for the current scope that the writer has not resolved.
// edited: the passage changed since the review.
export function coachIssues(state: EditorState): CoachIssue[] {
  const value = writingKey.getState(state)
  const check = value?.coach.get(scopeOf(state))
  if (!value || !value.preferences.coach || !check?.notes.length) return []
  const size = state.doc.content.size
  return check.notes.map(item => {
    const anchored = item.anchored && item.to > item.from && item.to <= size
    return { id: item.id, note: item.note, from: item.from, to: item.to, anchored, edited: !anchored || !!item.changed || passageText(state.doc, item.from, item.to) !== item.original }
  }).sort((a, b) => Number(b.anchored) - Number(a.anchored) || a.from - b.from)
}
export function coachStatus(state: EditorState) {
  const value = writingKey.getState(state)!
  const scope = scopeOf(state), check = value.coach.get(scope)
  const solved = value.coachResolved.filter(item => item.outcome === 'solved' && item.scope === scope).length
  return { enabled: value.preferences.coach, solved, check: check ? { status: check.status, stale: check.stale, provider: check.provider, model: check.model, dropped: check.dropped, error: check.error } : null }
}
function send(view: EditorView, meta: WritingMeta) { view.dispatch(view.state.tr.setMeta(writingKey, meta).setMeta('addToHistory', false)) }
export function configureWriting(view: EditorView, config: Omit<Extract<WritingMeta, { type: 'configure' }>, 'type'>) { send(view, { type: 'configure', ...config }) }
// Check writing runs Harper on the scope and, when the writer turned it on,
// asks the writing coach too.
export function checkWriting(view: EditorView) {
  const value = writingKey.getState(view.state)
  if (value?.manual.get(scopeOf(view.state))?.status !== 'checking') send(view, { type: 'manual', coach: !!value?.preferences.coach && supportedWritingLanguage(value.language) })
}
// Solved: the next review checks the revised passage. Dismissed: the writer
// keeps the wording, and the coach does not suggest it again.
export function solveCoach(view: EditorView, issue: CoachIssue) { send(view, { type: 'coach-resolve', id: issue.id, outcome: 'solved' }) }
export function dismissCoach(view: EditorView, issue: CoachIssue) { send(view, { type: 'coach-resolve', id: issue.id, outcome: 'dismissed' }) }
export function selectCoach(view: EditorView, issue: CoachIssue) {
  if (!issue.anchored || issue.to > view.state.doc.content.size) return
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, issue.from, issue.to)).scrollIntoView())
  view.focus()
}
export function dismissWriting(view: EditorView) { send(view, { type: 'dismiss' }) }
export function retryWriting(view: EditorView) { send(view, { type: 'retry' }) }
export function ignoreWriting(view: EditorView, issue: WritingIssue) { send(view, { type: 'ignore', node: issue.node, key: issue.key }) }
export function selectWriting(view: EditorView, issue: WritingIssue) { selectPassage(view, issue.node, issue.offset, issue.prose, issue.diagnostic.from, issue.diagnostic.to) }
function selectPassage(view: EditorView, node: Node, offset: number, prose: Prose, from: number, to: number) {
  if (view.state.doc.nodeAt(offset) !== node) return
  const ranges = proseRanges(prose, from, to)
  if (!ranges.length) return
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, offset + ranges[0].from, offset + ranges.at(-1)!.to)).scrollIntoView())
  view.focus()
}
export function applyWriting(view: EditorView, issue: WritingIssue, index: number): boolean {
  const replacement = issue.diagnostic.replacements[index]
  if (!replacement || view.state.doc.nodeAt(issue.offset) !== issue.node || !writingIssues(view.state).some(item => item.node === issue.node && item.key === issue.key)) return false
  const tr = replaceProse(view.state, issue.node, issue.offset, issue.prose, issue.diagnostic, replacement)
  if (!tr) return false
  view.dispatch(closeHistory(tr).scrollIntoView())
  // Each acceptance and subsequent typing belong to separate undo events.
  view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false))
  view.focus()
  return true
}

// storage: the document whose coach notes are kept on this computer.
export function writingPlugin(options: { language: string; preferences: WritingPreferences; check: (request: WritingRequest) => Promise<WritingResponse>; coach?: (request: CoachRequest) => Promise<CoachResult>; storage?: { documentId: string }; changed?: () => void; message?: (message: string) => void }): Plugin<WritingState> {
  let dismissMenu: (() => void) | undefined
  let revision = 0
  let coachToken = 0
  let decorated: { doc: Node; value: WritingState; set: DecorationSet } | undefined
  function menu(view: EditorView, position: number, x: number, y: number, preferCoach = false) {
    const at = (offset: number, prose: Prose, from: number, to: number) => proseRanges(prose, from, to).some(range => position >= offset + range.from && position <= offset + range.to)
    // A coach note offers its explanation and suggestion, Mark as solved and Dismiss.
    const coachNote = coachIssues(view.state).find(item => item.anchored && position >= item.from && position <= item.to)
    const issue = preferCoach && coachNote ? undefined : writingIssues(view.state).find(item => at(item.offset, item.prose, item.diagnostic.from, item.diagnostic.to))
    const note = issue ? undefined : coachNote
    if (!issue && !note) return false
    dismissMenu?.()
    const doc = view.dom.ownerDocument, host = doc.createElement('div')
    host.className = 'tinto-spelling-menu'
    host.setAttribute('role', 'menu'); host.setAttribute('aria-label', note ? 'Writing coach' : 'Writing suggestions')
    function line(text: string, className = '') {
      const div = doc.createElement('div'); div.textContent = text
      if (className) div.className = className
      host.append(div)
    }
    function action(label: string, run: () => void) {
      const button = doc.createElement('button')
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label
      button.onclick = () => { dismissMenu?.(); try { run() } catch (error) { options.message?.(String(error)) } }
      host.append(button)
    }
    if (note) {
      line(COACH_LABELS[note.note.kind] + ' · ' + note.note.title, 'coach-menu-title')
      line(note.note.explanation)
      if (note.note.suggestion) line('Suggestion: ' + note.note.suggestion, 'coach-menu-suggestion')
      action('Mark as solved', () => { solveCoach(view, note); view.focus() })
      action('Dismiss', () => { dismissCoach(view, note); view.focus() })
    } else if (issue) {
      line(issue.diagnostic.message)
      harperActions(issue)
    }
    function harperActions(issue: WritingIssue) {
    if (issue.manualReason) {
      const note = doc.createElement('div'); note.textContent = issue.manualReason; host.append(note)
    } else for (const [index, replacement] of issue.diagnostic.replacements.entries()) action(replacement.text || 'Remove', () => {
      if (!applyWriting(view, issue, index)) options.message?.('This passage has changed. Check again before applying a correction.')
    })
    if (!issue.diagnostic.replacements.length) { const note = doc.createElement('div'); note.textContent = 'No proposed correction. You can edit this passage manually.'; host.append(note) }
    action('Ignore', () => { ignoreWriting(view, issue); view.focus() })
    if (issue.diagnostic.category === 'Spelling' && validPersonalWord(issue.diagnostic.source)) action('Add to personal dictionary', () => { acceptWord(writingKey.getState(view.state)!.language, issue.diagnostic.source); view.focus() })
    if (issue.diagnostic.category !== 'Spelling') action('Disable this grammar rule', () => { disableWritingRule(issue.diagnostic.rule); view.focus() })
    }
    function outside(event: Event) { if (!host.contains(event.target as globalThis.Node)) dismissMenu?.() }
    dismissMenu = () => {
      doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', outside, true); doc.removeEventListener('scroll', outside, true)
      host.remove(); dismissMenu = undefined
    }
    host.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); dismissMenu?.(); view.focus() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...host.querySelectorAll('button')], at = buttons.indexOf(doc.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    doc.body.append(host)
    host.style.left = Math.max(4, Math.min(x, doc.documentElement.clientWidth - host.offsetWidth - 4)) + 'px'
    host.style.top = Math.max(4, Math.min(y, doc.documentElement.clientHeight - host.offsetHeight - 4)) + 'px'
    host.querySelector('button')?.focus({ preventScroll: true })
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', outside, true); doc.addEventListener('scroll', outside, true)
    return true
  }
  // Notes kept on this computer come back on the passages they quote.
  function restoreCoach(doc: Node): Pick<WritingState, 'coach' | 'coachResolved'> {
    const coach = new Map<string, CoachCheck>()
    if (!options.storage) return { coach, coachResolved: [] }
    const stored = loadCoach(options.storage.documentId)
    const size = doc.content.size
    const place = <T extends CoachNoteAt & { text: string }>(item: T): CoachNoteAt => {
      const { text, ...note } = item
      if (note.anchored && note.to <= size && note.from < note.to && passageText(doc, note.from, note.to) === text) return note
      const range = anchorPassage(doc, false, text || note.note.quote, note.from)
      return range ? { ...note, ...range, anchored: true, changed: note.changed || text !== note.original } : { ...note, anchored: false }
    }
    for (const [scope, check] of stored.checks) {
      coach.set(scope, { token: 0, status: 'ready', stale: check.stale, checked: [], notes: check.notes.map(place), dropped: check.dropped, provider: check.provider, model: check.model, reviewed: check.reviewed })
    }
    return { coach, coachResolved: stored.resolved.map(item => ({ ...place(item), outcome: item.outcome, scope: item.scope, at: item.at })) }
  }
  return new Plugin<WritingState>({
    key: writingKey,
    state: {
      init: (_config, instance) => ({ language: options.language, markdown: false, preferences: options.preferences, revision: ++revision, automatic: [], manual: new Map(), ignored: [], ...restoreCoach(instance.doc), autoStatus: 'idle' }),
      apply(tr, previous, oldState, state) {
        const meta: WritingMeta | undefined = tr.getMeta(writingKey)
        const scopeChanged = scopeOf(oldState) !== scopeOf(state)
        if (!tr.docChanged && !meta && !scopeChanged) return previous
        const next = { ...previous, manual: new Map(previous.manual), coach: new Map(previous.coach) }
        if (tr.docChanged || scopeChanged || (meta && ['configure', 'view', 'manual', 'dismiss', 'retry'].includes(meta.type))) {
          next.revision = ++revision
          next.autoStatus = 'idle'; next.error = undefined
          for (const [scope, manual] of next.manual) if (manual.status === 'checking') next.manual.set(scope, { ...manual, status: 'edited' })
        }
        if (tr.docChanged) {
          const nodes = new Set(state.doc.children)
          next.automatic = previous.automatic.filter(item => nodes.has(item.node))
          next.ignored = previous.ignored.filter(item => nodes.has(item.node))
          for (const [scope, manual] of next.manual) {
            const section = scope ? findSection(state.doc, scope) : null
            if (scope && !section) { next.manual.delete(scope); continue }
            const inScope = new Set<Node>()
            state.doc.forEach((node, offset) => { if (!section || (offset >= section.from && offset < section.to)) inScope.add(node) })
            const blocks = manual.blocks.filter(item => inScope.has(item.node))
            const checked = new Set(blocks.map(item => item.node))
            if (blocks.length !== manual.blocks.length || [...inScope].some(node => !checked.has(node))) next.manual.set(scope, { ...manual, blocks, status: 'edited', error: undefined })
          }
          // Coach notes follow the text; a deleted passage leaves its note unmarked.
          const moved = <T extends CoachNoteAt>(item: T): T => {
            if (!item.anchored) return item
            const from = tr.mapping.map(item.from, 1), to = tr.mapping.map(item.to, -1)
            return to > from ? { ...item, from, to } : { ...item, from, to: from, anchored: false }
          }
          next.coachResolved = previous.coachResolved.map(moved)
          for (const [scope, check] of next.coach) {
            const section = scope ? findSection(state.doc, scope) : null
            const inScope = new Set<Node>()
            state.doc.forEach((node, offset) => { if (!section || (offset >= section.from && offset < section.to)) inScope.add(node) })
            const checked = check.checked.filter(node => inScope.has(node)), sent = new Set(check.checked)
            const stale = check.stale || !check.checked.length || checked.length !== check.checked.length || [...inScope].some(node => !sent.has(node))
            next.coach.set(scope, { ...check, checked, notes: check.notes.map(moved), stale })
          }
        }
        if (meta?.type === 'view') {
          const nodes = new Map<Node, Node>()
          meta.fromDoc.forEach((node, _pos, index) => {
            const target = state.doc.maybeChild(index)
            if (target && writingProse(node, meta.source.markdown).text === writingProse(target, meta.markdown).text) nodes.set(node, target)
          })
          const remap = (blocks: BlockCheck[]) => blocks.filter(item => nodes.has(item.node)).map(item => ({ ...item, node: nodes.get(item.node)! }))
          next.language = meta.source.language; next.preferences = meta.source.preferences; next.markdown = meta.markdown
          next.automatic = remap(meta.source.automatic)
          next.ignored = meta.source.ignored.filter(item => nodes.has(item.node)).map(item => ({ ...item, node: nodes.get(item.node)! }))
          next.manual = new Map([...meta.source.manual].map(([scope, manual]) => {
            const blocks = remap(manual.blocks)
            return [scope, { ...manual, blocks, status: blocks.length !== manual.blocks.length || manual.status === 'checking' ? 'edited' : manual.status }]
          }))
          // Markdown and formatted views are different documents: find each
          // coach note's passage again by its text, in the same paragraph.
          const starts: number[] = []
          state.doc.forEach((_node, offset) => { starts.push(offset) })
          const reanchor = <T extends CoachNoteAt>(item: T): T => {
            if (!item.anchored) return item
            let index = 0
            meta.fromDoc.forEach((node, offset, i) => { if (item.from >= offset && item.from < offset + node.nodeSize) index = i })
            const text = proseText(meta.fromDoc, meta.source.markdown, item.from, item.to)
            const range = text ? anchorPassage(state.doc, meta.markdown, text, starts[index] ?? 0) : null
            if (!range) return { ...item, anchored: false }
            const changed = !!item.changed || passageText(meta.fromDoc, item.from, item.to) !== item.original
            return { ...item, ...range, original: passageText(state.doc, range.from, range.to), changed }
          }
          next.coach = new Map([...meta.source.coach].map(([scope, check]) => {
            const checked = check.checked.filter(node => nodes.has(node)).map(node => nodes.get(node)!)
            return [scope, { ...check, checked, notes: check.notes.map(reanchor), stale: check.stale || checked.length !== check.checked.length }]
          }))
          next.coachResolved = meta.source.coachResolved.map(reanchor)
        } else if (meta?.type === 'configure') {
          const language = meta.language ?? next.language, markdown = meta.markdown ?? next.markdown
          if (language !== next.language || markdown !== next.markdown || meta.reset) {
            next.manual.clear(); next.ignored = []
          }
          // Coach notes belong to the document's language; turning the coach
          // off only hides them.
          if (language !== next.language || meta.reset) { next.coach.clear(); next.coachResolved = [] }
          const preferences = meta.preferences ?? next.preferences
          const dictionary = dictionaryLanguage(language)
          const filtersChanged = JSON.stringify([next.preferences.words[dictionary], next.preferences.disabledRules, next.preferences.style]) !== JSON.stringify([preferences.words[dictionary], preferences.disabledRules, preferences.style])
          next.language = language; next.markdown = markdown; next.preferences = preferences
          next.automatic = []
          // Keep the original diagnostics so restoring a rule or removing an
          // accepted word can reveal an unchanged passage again.
          if (filtersChanged) for (const [scope, manual] of next.manual) next.manual.set(scope, { ...manual, status: 'edited', error: undefined })
        } else if (meta?.type === 'manual') {
          next.manual.set(scopeOf(state), { blocks: [], status: 'checking' })
          // The current notes stay visible until the new review replaces them.
          const old = next.coach.get(scopeOf(state))
          if (meta.coach) next.coach.set(scopeOf(state), { notes: [], dropped: 0, ...old, token: ++coachToken, status: 'checking', stale: false, checked: scopedBlocks(state).map(item => item.node), error: undefined })
        } else if (meta?.type === 'dismiss') next.manual.delete(scopeOf(state))
        else if (meta?.type === 'coach-results') {
          const check = next.coach.get(meta.scope)
          if (check?.token === meta.token && meta.error) next.coach.set(meta.scope, { ...check, status: 'error', error: meta.error })
          else if (check?.token === meta.token) {
            // Each note is placed on its passage now; a paragraph edited during
            // the review is searched for the quote.
            const offsets = new Map<Node, number>()
            state.doc.forEach((node, offset) => { offsets.set(node, offset) })
            const section = meta.scope ? findSection(state.doc, meta.scope) : null
            const notes = meta.notes.map(({ node, start, note }): CoachNoteAt => {
              const offset = offsets.get(node)
              const range = offset !== undefined ? blockRange(node, offset, next.markdown, note.from, note.to) : anchorPassage(state.doc, next.markdown, note.quote, start, section)
              return range ? { id: newNoteId(), note, ...range, original: passageText(state.doc, range.from, range.to), anchored: true } : { id: newNoteId(), note, from: 0, to: 0, original: note.quote, anchored: false }
            })
            next.coach.set(meta.scope, { ...check, status: 'ready', notes, dropped: meta.dropped, provider: meta.provider, model: meta.model, error: undefined, reviewed: new Date().toISOString() })
          }
        } else if (meta?.type === 'coach-resolve') {
          for (const [scope, check] of next.coach) {
            const item = check.notes.find(note => note.id === meta.id)
            if (!item) continue
            next.coach.set(scope, { ...check, notes: check.notes.filter(note => note !== item) })
            next.coachResolved = [...next.coachResolved, { ...item, outcome: meta.outcome, scope, at: new Date().toISOString() }].slice(-COACH_RESOLVED)
          }
        }
        else if (meta?.type === 'retry') next.automatic = []
        else if (meta?.type === 'ignore') next.ignored = [...next.ignored, { node: meta.node, key: meta.key }]
        else if (meta?.type === 'started' && meta.revision === next.revision) next.autoStatus = 'checking'
        else if (meta?.type === 'results' && meta.revision === next.revision) {
          if (meta.manual) {
            const old = next.manual.get(scopeOf(state))
            if (old) next.manual.set(scopeOf(state), { blocks: [...old.blocks, ...meta.blocks], status: meta.error ? 'error' : meta.done ? 'ready' : 'checking', error: meta.error })
          } else {
            next.automatic = [...next.automatic, ...meta.blocks]
            next.autoStatus = meta.error ? 'error' : meta.done ? 'ready' : 'checking'; next.error = meta.error
          }
        }
        return next
      }
    },
    props: {
      decorations(state) {
        const value = writingKey.getState(state)!
        if (decorated?.doc === state.doc && decorated.value === value) return decorated.set
        const decorations: Decoration[] = []
        for (const issue of writingIssues(state)) for (const range of proseRanges(issue.prose, issue.diagnostic.from, issue.diagnostic.to)) {
          const spelling = issue.diagnostic.category === 'Spelling'
          decorations.push(Decoration.inline(issue.offset + range.from, issue.offset + range.to, { class: spelling ? 'tinto-misspelling' : 'tinto-grammar', 'data-word': issue.diagnostic.source, 'data-writing-rule': issue.diagnostic.rule }))
        }
        for (const issue of coachIssues(state)) if (issue.anchored) {
          decorations.push(Decoration.inline(issue.from, issue.to, { class: issue.edited ? 'tinto-coach tinto-coach-edited' : 'tinto-coach', 'data-coach-note': issue.note.kind }))
        }
        const set = DecorationSet.create(state.doc, decorations)
        decorated = { doc: state.doc, value, set }
        return set
      },
      handleDOMEvents: { contextmenu(view, event) {
        const target = event.target instanceof Element ? event.target.closest('[data-writing-rule], [data-coach-note]') : null
        if (!target || !menu(view, view.posAtDOM(target, 0), event.clientX, event.clientY, target.hasAttribute('data-coach-note'))) return false
        event.preventDefault(); return true
      } },
      handleKeyDown(view, event) {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false
        const position = view.state.selection.head, { left, bottom } = view.coordsAtPos(position)
        return menu(view, position, left, bottom)
      }
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | undefined, destroyed = false, running = false, scheduled = false
      const notify = () => queueMicrotask(() => { if (!destroyed) options.changed?.() })
      function schedule() {
        clearTimeout(timer)
        const state = writingKey.getState(view.state)!
        const manual = state.manual.get(scopeOf(view.state))?.status === 'checking'
        if (!manual && !liveEnabled(state)) return
        scheduled = true
        timer = setTimeout(() => { if (!running) void run() }, manual ? 0 : 500)
      }
      async function run() {
        if (destroyed) return
        running = true; scheduled = false
        const snapshot = view.state, state = writingKey.getState(snapshot)!, revision = state.revision
        const manual = state.manual.get(scopeOf(snapshot))?.status === 'checking'
        const current = () => !destroyed && writingKey.getState(view.state)?.revision === revision
        const nodes = scopedBlocks(snapshot).map(item => item.node).filter(node => manual || !state.automatic.some(item => item.node === node))
        try {
          if (!supportedWritingLanguage(state.language)) {
            send(view, { type: 'results', revision, manual, blocks: [], done: true, error: { code: 'unsupported-language' } })
            return
          }
          if (!manual) send(view, { type: 'started', revision })
          const jobs: { id: string; node: Node; start: number; text: string }[] = []
          const remaining = new Map<Node, number>(), accumulated = new Map<Node, WritingDiagnostic[]>()
          for (const node of nodes) {
            const prose = writingProse(node, state.markdown)
            // Bound each request, including a single unusually long paragraph.
            // Splits prefer sentence/word boundaries and never divide a surrogate.
            let start = 0
            do {
              let end = Math.min(prose.text.length, start + WRITING_BLOCK_LIMIT)
              if (end < prose.text.length) {
                const tail = prose.text.slice(start, end), boundary = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('. '), tail.lastIndexOf(' '))
                if (boundary > tail.length / 2) end = start + boundary + 1
                else if (/[\uD800-\uDBFF]/.test(prose.text[end - 1])) end--
              }
              jobs.push({ id: String(jobs.length), node, start, text: prose.text.slice(start, end) })
              remaining.set(node, (remaining.get(node) ?? 0) + 1)
              start = end
            } while (start < prose.text.length)
          }
          for (let cursor = 0; cursor < jobs.length;) {
            if (!current()) return
            const batch: typeof jobs = []
            let length = 0
            while (cursor < jobs.length && batch.length < 32 && length + jobs[cursor].text.length <= WRITING_BATCH_LIMIT) {
              const job = jobs[cursor++]; length += job.text.length; batch.push(job)
            }
            const response = await options.check({ language: state.language, spelling: manual || state.preferences.spelling, grammar: english(state.language) && (manual || state.preferences.grammar), style: english(state.language) && state.preferences.style, words: state.preferences.words[dictionaryLanguage(state.language)] ?? [], disabledRules: state.preferences.disabledRules, blocks: batch.map(({ id, text }) => ({ id, text })) })
            if (!current()) return
            if (response.error) {
              send(view, { type: 'results', revision, manual, blocks: [], done: true, error: response.error })
              return
            }
            const finished: BlockCheck[] = []
            for (const job of batch) {
              const result = response.blocks.find(block => block.id === job.id)
              if (!result) throw Error('Incomplete writing check.')
              const diagnostics = accumulated.get(job.node) ?? []
              for (const d of result.diagnostics) diagnostics.push({ ...d, from: d.from + job.start, to: d.to + job.start, replacements: d.replacements.map(r => ({ ...r, from: r.from + job.start, to: r.to + job.start })) })
              accumulated.set(job.node, diagnostics)
              remaining.set(job.node, remaining.get(job.node)! - 1)
              if (remaining.get(job.node) === 0) finished.push({ node: job.node, diagnostics })
            }
            send(view, { type: 'results', revision, manual, blocks: finished, done: false })
          }
          if (current()) send(view, { type: 'results', revision, manual, blocks: [], done: true })
        } catch {
          if (current()) send(view, { type: 'results', revision, manual, blocks: [], done: true, error: { code: 'unavailable' } })
        } finally {
          running = false
          if (scheduled && !destroyed) schedule()
        }
      }
      // The writing coach is asked once per Check writing, with the chosen
      // wording of the blocks checked and the notes the writer resolved in this
      // scope. Nothing in the manuscript is modified.
      let coachSent = 0
      function coach() {
        const state = writingKey.getState(view.state)!, scope = scopeOf(view.state), check = state.coach.get(scope)
        if (!check || check.status !== 'checking' || check.token === coachSent) return
        const token = coachSent = check.token
        const done = (result: Omit<Extract<WritingMeta, { type: 'coach-results' }>, 'type' | 'scope' | 'token'>) => { if (!destroyed) send(view, { type: 'coach-results', scope, token, ...result }) }
        const doc = view.state.doc, starts = new Map<Node, number>()
        doc.forEach((node, offset) => { starts.set(node, offset) })
        const nodes = new Map<string, { node: Node; start: number }>()
        const blocks = check.checked.map(node => ({ node, text: writingProse(node, state.markdown).text })).filter(block => block.text.trim()).map((block, index) => {
          nodes.set('p' + (index + 1), { node: block.node, start: starts.get(block.node) ?? 0 })
          return { id: 'p' + (index + 1), text: block.text }
        })
        const section = scope ? findSection(doc, scope) : null
        const resolved: ResolvedNote[] = state.coachResolved
          .filter(item => item.scope === scope || (item.anchored && (!section || (item.from >= section.from && item.from < section.to))))
          .slice(-COACH_RESOLVED)
          .map(item => ({ outcome: item.outcome, kind: item.note.kind, title: item.note.title, quote: item.note.quote, now: (item.anchored && item.to <= doc.content.size && proseText(doc, state.markdown, item.from, item.to)) || item.note.quote }))
        if (!blocks.length) return queueMicrotask(() => done({ notes: [], dropped: 0 }))
        if (blocks.reduce((sum, block) => sum + block.text.length, 0) > COACH_LIMIT) return queueMicrotask(() => done({ notes: [], dropped: 0, error: 'The writing coach reviews up to about 10,000 words at a time. Check a linked section instead.' }))
        if (!options.coach) return queueMicrotask(() => done({ notes: [], dropped: 0, error: 'The writing coach is unavailable.' }))
        options.coach({ language: state.language, blocks, ...(resolved.length ? { resolved } : {}) }).then(
          result => done({ notes: result.notes.filter(note => nodes.has(note.block)).map(note => ({ ...nodes.get(note.block)!, note })), dropped: result.dropped, provider: result.provider, model: result.model }),
          error => done({ notes: [], dropped: 0, error: errorMessage(error) })
        )
      }
      // Coach notes are saved on this computer shortly after they change.
      let saveTimer: ReturnType<typeof setTimeout> | undefined
      const written = new Set<string>()
      function save() {
        clearTimeout(saveTimer); saveTimer = undefined
        const id = options.storage?.documentId, state = writingKey.getState(view.state)
        if (!id || !state) return
        const doc = view.state.doc, size = doc.content.size
        const stored = (item: CoachNoteAt) => ({ ...item, text: item.anchored && item.to <= size ? passageText(doc, item.from, item.to) : '' })
        for (const [scope, check] of state.coach) {
          if (!check.notes.length && !check.reviewed) continue
          const value: StoredCheck = { notes: check.notes.map(stored), dropped: check.dropped, provider: check.provider, model: check.model, reviewed: check.reviewed, stale: check.stale }
          saveCoachScope(id, scope, value); written.add(scope)
        }
        for (const scope of written) if (!state.coach.has(scope)) { saveCoachScope(id, scope, null); written.delete(scope) }
        saveCoachResolved(id, state.coachResolved.map(item => ({ ...stored(item), outcome: item.outcome, scope: item.scope, at: item.at })))
      }
      schedule()
      return {
        update(_view, previous) {
          const before = writingKey.getState(previous), after = writingKey.getState(view.state)
          if (before !== after) { notify(); coach() }
          if (before?.revision !== after?.revision) { dismissMenu?.(); schedule() }
          if (options.storage && before && after) {
            if (before.language !== after.language) { clearCoach(options.storage.documentId); written.clear() }
            else if (before.coach !== after.coach || before.coachResolved !== after.coachResolved) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400) }
          }
        },
        destroy() { destroyed = true; clearTimeout(timer); dismissMenu?.(); if (saveTimer) save() }
      }
    }
  })
}
