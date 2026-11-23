import type { Node } from 'prosemirror-model'
import { closeHistory } from 'prosemirror-history'
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { findSection, sectionKey } from './section'
import { writingProse, proseRanges, manualCorrectionReason, replaceProse, type Prose } from './writing-prose'
import { acceptWord, disableWritingRule, type WritingPreferences } from './writing-preferences'
import { dictionaryLanguage, english, normalizedWord, supportedWritingLanguage, validPersonalWord, WRITING_BATCH_LIMIT, WRITING_BLOCK_LIMIT, type WritingDiagnostic, type WritingFailure, type WritingRequest, type WritingResponse } from './writing-types'

type Status = 'idle' | 'checking' | 'ready' | 'edited' | 'error'
interface BlockCheck { node: Node; diagnostics: WritingDiagnostic[] }
interface ManualCheck { blocks: BlockCheck[]; status: Status; error?: WritingFailure }
interface Ignored { node: Node; key: string }
export interface WritingState {
  language: string
  markdown: boolean
  preferences: WritingPreferences
  revision: number
  automatic: BlockCheck[]
  manual: Map<string, ManualCheck>
  ignored: Ignored[]
  autoStatus: Status
  error?: WritingFailure
}
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
  | { type: 'manual' | 'dismiss' | 'retry' }
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
function send(view: EditorView, meta: WritingMeta) { view.dispatch(view.state.tr.setMeta(writingKey, meta).setMeta('addToHistory', false)) }
export function configureWriting(view: EditorView, config: Omit<Extract<WritingMeta, { type: 'configure' }>, 'type'>) { send(view, { type: 'configure', ...config }) }
export function checkWriting(view: EditorView) {
  if (writingKey.getState(view.state)?.manual.get(scopeOf(view.state))?.status !== 'checking') send(view, { type: 'manual' })
}
export function dismissWriting(view: EditorView) { send(view, { type: 'dismiss' }) }
export function retryWriting(view: EditorView) { send(view, { type: 'retry' }) }
export function ignoreWriting(view: EditorView, issue: WritingIssue) { send(view, { type: 'ignore', node: issue.node, key: issue.key }) }
export function selectWriting(view: EditorView, issue: WritingIssue) {
  if (view.state.doc.nodeAt(issue.offset) !== issue.node) return
  const ranges = proseRanges(issue.prose, issue.diagnostic.from, issue.diagnostic.to)
  if (!ranges.length) return
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, issue.offset + ranges[0].from, issue.offset + ranges.at(-1)!.to)).scrollIntoView())
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

export function writingPlugin(options: { language: string; preferences: WritingPreferences; check: (request: WritingRequest) => Promise<WritingResponse>; changed?: () => void; message?: (message: string) => void }): Plugin<WritingState> {
  let dismissMenu: (() => void) | undefined
  let revision = 0
  let decorated: { doc: Node; value: WritingState; set: DecorationSet } | undefined
  function menu(view: EditorView, position: number, x: number, y: number) {
    const issue = writingIssues(view.state).find(item => proseRanges(item.prose, item.diagnostic.from, item.diagnostic.to).some(range => position >= item.offset + range.from && position <= item.offset + range.to))
    if (!issue) return false
    dismissMenu?.()
    const doc = view.dom.ownerDocument, host = doc.createElement('div')
    host.className = 'tinto-spelling-menu'
    host.setAttribute('role', 'menu'); host.setAttribute('aria-label', 'Writing suggestions')
    const caption = doc.createElement('div')
    caption.textContent = issue.diagnostic.message
    host.append(caption)
    function action(label: string, run: () => void) {
      const button = doc.createElement('button')
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label
      button.onclick = () => { dismissMenu?.(); try { run() } catch (error) { options.message?.(String(error)) } }
      host.append(button)
    }
    if (issue.manualReason) {
      const note = doc.createElement('div'); note.textContent = issue.manualReason; host.append(note)
    } else for (const [index, replacement] of issue.diagnostic.replacements.entries()) action(replacement.text || 'Remove', () => {
      if (!applyWriting(view, issue, index)) options.message?.('This passage has changed. Check again before applying a correction.')
    })
    if (!issue.diagnostic.replacements.length) { const note = doc.createElement('div'); note.textContent = 'No proposed correction. You can edit this passage manually.'; host.append(note) }
    action('Ignore', () => { ignoreWriting(view, issue); view.focus() })
    if (issue.diagnostic.category === 'Spelling' && validPersonalWord(issue.diagnostic.source)) action('Add to personal dictionary', () => { acceptWord(writingKey.getState(view.state)!.language, issue.diagnostic.source); view.focus() })
    if (issue.diagnostic.category !== 'Spelling') action('Disable this grammar rule', () => { disableWritingRule(issue.diagnostic.rule); view.focus() })
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
  return new Plugin<WritingState>({
    key: writingKey,
    state: {
      init: () => ({ language: options.language, markdown: false, preferences: options.preferences, revision: ++revision, automatic: [], manual: new Map(), ignored: [], autoStatus: 'idle' }),
      apply(tr, previous, oldState, state) {
        const meta: WritingMeta | undefined = tr.getMeta(writingKey)
        const scopeChanged = scopeOf(oldState) !== scopeOf(state)
        if (!tr.docChanged && !meta && !scopeChanged) return previous
        const next = { ...previous, manual: new Map(previous.manual) }
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
        } else if (meta?.type === 'configure') {
          const language = meta.language ?? next.language, markdown = meta.markdown ?? next.markdown
          if (language !== next.language || markdown !== next.markdown || meta.reset) {
            next.manual.clear(); next.ignored = []
          }
          const preferences = meta.preferences ?? next.preferences
          const dictionary = dictionaryLanguage(language)
          const filtersChanged = JSON.stringify([next.preferences.words[dictionary], next.preferences.disabledRules]) !== JSON.stringify([preferences.words[dictionary], preferences.disabledRules])
          next.language = language; next.markdown = markdown; next.preferences = preferences
          next.automatic = []
          // Keep the original diagnostics so restoring a rule or removing an
          // accepted word can reveal an unchanged passage again.
          if (filtersChanged) for (const [scope, manual] of next.manual) next.manual.set(scope, { ...manual, status: 'edited', error: undefined })
        } else if (meta?.type === 'manual') next.manual.set(scopeOf(state), { blocks: [], status: 'checking' })
        else if (meta?.type === 'dismiss') next.manual.delete(scopeOf(state))
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
        const set = DecorationSet.create(state.doc, decorations)
        decorated = { doc: state.doc, value, set }
        return set
      },
      handleDOMEvents: { contextmenu(view, event) {
        const target = event.target instanceof Element ? event.target.closest('[data-writing-rule]') : null
        if (!target || !menu(view, view.posAtDOM(target, 0), event.clientX, event.clientY)) return false
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
            const response = await options.check({ language: state.language, spelling: manual || state.preferences.spelling, grammar: english(state.language) && (manual || state.preferences.grammar), words: state.preferences.words[dictionaryLanguage(state.language)] ?? [], disabledRules: state.preferences.disabledRules, blocks: batch.map(({ id, text }) => ({ id, text })) })
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
      schedule()
      return {
        update(_view, previous) {
          const before = writingKey.getState(previous), after = writingKey.getState(view.state)
          if (before !== after) notify()
          if (before?.revision !== after?.revision) { dismissMenu?.(); schedule() }
        },
        destroy() { destroyed = true; clearTimeout(timer); dismissMenu?.() }
      }
    }
  })
}
