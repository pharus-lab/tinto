import type { EditorView } from 'prosemirror-view'
import type { WritingSample } from './desktop'
import { INTERVAL_BANDS } from './model'

// Measures how a document is being written, for its authorship record: how
// many characters are typed and deleted, the time spent typing, and how long
// the writer pauses between keys, counted by band. It never keeps the text or
// which keys were pressed. Text pasted or dropped from outside Tinto is counted
// separately; moving text within Tinto is neither.
export interface EvidenceTarget { path: string; projectId: string; documentId: string }
type Send = (target: EvidenceTarget, kind: 'typing' | 'paste', sample: WritingSample) => void

const PAUSE = 60_000
const FLUSH_AFTER = 60_000
const PASSAGE = 'application/x-tinto-passage+json'
const band = (ms: number) => {
  const index = INTERVAL_BANDS.findIndex(limit => ms < limit)
  return index < 0 ? INTERVAL_BANDS.length : index
}

export function trackWriting(view: EditorView, target: EvidenceTarget, send: Send) {
  let typed = 0
  let deleted = 0
  let activeMs = 0
  let intervals: number[] = new Array(INTERVAL_BANDS.length + 1).fill(0)
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (!typed && !deleted) return
    send(target, 'typing', { typed, deleted, activeMs: Math.round(activeMs), intervals })
    typed = deleted = activeMs = 0
    intervals = intervals.map(() => 0)
  }
  function keystroke(characters: number, removed: boolean, repeat: boolean) {
    const now = performance.now()
    if (last) {
      const gap = now - last
      if (gap < PAUSE) activeMs += gap
      // A held key repeats at a fixed rate, which says nothing about the writer.
      if (!repeat) intervals[band(gap)]++
    }
    last = now
    if (removed) deleted += characters
    else typed += characters
    timer ??= setTimeout(flush, FLUSH_AFTER)
  }
  function pasted(data: DataTransfer | null) {
    if (!data || data.types.includes(PASSAGE) || data.types.includes('application/x-tinto-markdown+json')) return
    const characters = [...data.getData('text/plain')].length
    if (characters) send(target, 'paste', { characters })
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || !view.editable) return
    if (event.key === 'Backspace' || event.key === 'Delete') keystroke(1, true, event.repeat)
    else if (event.key === 'Enter' || [...event.key].length === 1) keystroke(1, false, event.repeat)
  }
  // Input methods compose a character from several keys; it counts once, when composed.
  const composed = (event: CompositionEvent) => { if (event.data) keystroke([...event.data].length, false, false) }
  const paste = (event: ClipboardEvent) => pasted(event.clipboardData)
  const drop = (event: DragEvent) => { if (!view.dragging) pasted(event.dataTransfer) }
  const dom = view.dom
  dom.addEventListener('keydown', keydown)
  dom.addEventListener('compositionend', composed)
  dom.addEventListener('paste', paste)
  dom.addEventListener('drop', drop, true)
  return {
    flush,
    stop() {
      flush()
      dom.removeEventListener('keydown', keydown)
      dom.removeEventListener('compositionend', composed)
      dom.removeEventListener('paste', paste)
      dom.removeEventListener('drop', drop, true)
    }
  }
}
