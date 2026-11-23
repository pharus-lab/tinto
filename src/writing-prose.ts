import { parser as markdownParser } from '@lezer/markdown'
import { diffChars } from 'diff'
import type { Mark, Node } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import { markdownFormatting } from './exchange'
import type { WritingDiagnostic, WritingReplacement } from './writing-types'

export interface Prose {
  text: string
  // Each UTF-16 unit points into the block, including its opening token.
  positions: number[]
  parents: string[]
  origins: string[]
}
const caches = [new WeakMap<Node, Prose>(), new WeakMap<Node, Prose>()]
export function writingProse(block: Node, markdown: boolean): Prose {
  const cache = caches[Number(markdown)], known = cache.get(block)
  if (known) return known
  const raw: Prose = { text: '', positions: [], parents: [], origins: [] }
  function visit(parent: Node, start: number, path: string) {
    parent.forEach((child, offset) => {
      if (child.isText) {
        const text = child.text!, origin = child.marks.find(mark => mark.type.name === 'origin')?.attrs.source ?? ''
        raw.text += text
        for (let i = 0; i < text.length; i++) {
          raw.positions.push(start + offset + i)
          raw.parents.push(path)
          raw.origins.push(origin)
        }
      } else visit(child, start + offset + 1, path + '/' + child.attrs.id)
    })
  }
  visit(block, 1, '') // A choice node contains only its chosen alternative.
  if (!markdown) { cache.set(block, raw); return raw }
  const hidden = new Uint8Array(raw.text.length)
  for (const run of markdownFormatting(raw.text).runs(0, raw.text.length)) if (run.hidden) hidden.fill(1, run.from, run.to)
  // Code, images, HTML and URLs are not prose. Leave a sentence boundary in
  // their place so words on either side cannot be joined by a suggestion.
  const breaks = new Set<number>()
  markdownParser.parse(raw.text).iterate({ enter(node) {
    // Supported inline HTML formatting (including Tinto's underline) is
    // already hidden by markdownFormatting. Keep the word continuous.
    if (node.name === 'HTMLTag' && hidden[node.from] && /^<\/?(?:u|strong|em)>$/i.test(raw.text.slice(node.from, node.to))) return false
    if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'Autolink', 'HTMLTag', 'HTMLBlock', 'LinkReference'].includes(node.name)) {
      hidden.fill(1, node.from, node.to)
      breaks.add(node.from)
      return false
    }
  } })
  const prose: Prose = { text: '', positions: [], parents: [], origins: [] }
  for (let i = 0; i < raw.text.length; i++) {
    if (breaks.has(i)) {
      prose.text += '\n'; prose.positions.push(-1); prose.parents.push('excluded'); prose.origins.push('excluded')
    }
    if (hidden[i]) continue
    prose.text += raw.text[i]
    prose.positions.push(raw.positions[i]); prose.parents.push(raw.parents[i]); prose.origins.push(raw.origins[i])
  }
  cache.set(block, prose)
  return prose
}

export function proseRanges(prose: Prose, from: number, to: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  for (let i = from; i < to; i++) {
    const position = prose.positions[i]
    if (position === undefined || position < 0) continue
    const last = ranges.at(-1)
    if (last?.to === position) last.to++
    else ranges.push({ from: position, to: position + 1 })
  }
  return ranges
}
export function manualCorrectionReason(prose: Prose, diagnostic: WritingDiagnostic): string | null {
  const { from, to, source } = diagnostic
  if (from < 0 || to > prose.text.length || from >= to || prose.text.slice(from, to) !== source) return 'This passage has changed. Check again.'
  if (prose.positions.slice(from, to).some(pos => pos < 0) || new Set(prose.parents.slice(from, to)).size !== 1) return 'This suggestion crosses an alternative or a markup boundary. Edit the passage manually.'
  if (new Set(prose.origins.slice(from, to)).size !== 1) return 'This passage contains text from different origins. Edit it manually to preserve attribution.'
  return null
}

// Produce only changed letter ranges, preserving unchanged letters, marks,
// Markdown delimiters and their existing origins. diffChars respects Unicode
// code points; ProseMirror positions remain UTF-16 throughout the mapping.
export function replaceProse(state: EditorState, block: Node, offset: number, prose: Prose, diagnostic: WritingDiagnostic, replacement: WritingReplacement): Transaction | null {
  if (manualCorrectionReason(prose, diagnostic) || replacement.from < diagnostic.from || replacement.to > diagnostic.to || replacement.from > replacement.to) return null
  const patches: { from: number; to: number; text: string }[] = []
  let cursor = replacement.from
  let patch: typeof patches[number] | undefined
  for (const part of diffChars(prose.text.slice(replacement.from, replacement.to), replacement.text)) {
    if (part.added || part.removed) {
      patch ??= { from: cursor, to: cursor, text: '' }
      if (part.added) patch.text += part.value
      else { cursor += part.value.length; patch.to = cursor }
    } else {
      if (patch) { patches.push(patch); patch = undefined }
      cursor += part.value.length
    }
  }
  if (patch) patches.push(patch)
  if (!patches.length) return null
  const tr = state.tr
  for (const change of patches.reverse()) {
    const ranges = proseRanges(prose, change.from, change.to)
    // At an insertion boundary, prefer the source's preceding character,
    // except at the beginning of the diagnosed passage.
    const index = change.from === diagnostic.from ? change.from : change.from - 1
    const markPosition = prose.positions[index]
    const insertion = ranges[0]?.from ?? (change.from === diagnostic.from ? prose.positions[change.from] : prose.positions[change.from - 1] + 1)
    if (insertion === undefined || insertion < 0 || markPosition < 0) return null
    let marks: readonly Mark[] = []
    block.nodesBetween(markPosition - 1, markPosition, node => { if (node.isText) marks = node.marks })
    // A replacement must inherit the replaced text's origin, including at
    // the edge of a non-inclusive origin mark.
    if (ranges.length) block.nodesBetween(ranges[0].from - 1, ranges[0].from, node => { if (node.isText) marks = node.marks })
    for (const range of ranges.reverse()) tr.delete(offset + range.from, offset + range.to)
    if (change.text) tr.insert(offset + insertion, state.schema.text(change.text, marks))
  }
  return tr
}
