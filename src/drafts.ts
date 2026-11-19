import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { sectionRange, type BlockJSON, type InlineJSON, type MarkJSON } from './model'
import type { DocumentRecord, DraftChange, DraftResolution } from './project-types'

export interface DraftBaseline {
  blocks: BlockJSON[]
  before: string[]
  after: string[]
}

const ids = (blocks: BlockJSON[]) => blocks.map(block => block.attrs.id)
const byId = (blocks: BlockJSON[]) => new Map(blocks.map(block => [block.attrs.id, block]))

export function forkDraft(source: DocumentRecord, headingId: string | null, title: string) {
  const contents = source.manuscript.content
  const range = headingId ? sectionRange(source.manuscript, headingId) : { from: 0, to: contents.length }
  if (range.from === range.to) throw Error('This section is no longer in its source document.')
  const blocks = contents.slice(range.from, range.to)
  const baseline = { blocks, before: ids(contents.slice(0, range.from)), after: ids(contents.slice(range.to)) }
  const draft: DocumentRecord = {
    id: randomUUID(), title, language: source.language, source: { documentId: source.id, headingId },
    manuscript: { type: 'doc', content: structuredClone(blocks) }
  }
  return { draft, baseline }
}

// Unchanged neighbours still locate the section after an author deletes its
// heading. They also keep draft additions out of the following chapter.
function sourceRange(source: DocumentRecord, draft: DocumentRecord, baseline: DraftBaseline) {
  const blocks = source.manuscript.content
  if (!draft.source?.headingId) return { from: 0, to: blocks.length }
  const live = sectionRange(source.manuscript, draft.source.headingId)
  if (live.from < live.to) {
    // Previously accepted draft blocks can extend the original section,
    // including when the author added another heading to the draft itself.
    const tracked = new Set(ids(baseline.blocks))
    while (live.from > 0 && tracked.has(blocks[live.from - 1].attrs.id)) live.from--
    while (live.to < blocks.length && tracked.has(blocks[live.to].attrs.id)) live.to++
    return live
  }
  const before = new Set(baseline.before)
  const after = new Set(baseline.after)
  const firstAfter = blocks.findIndex(block => after.has(block.attrs.id))
  const to = firstAfter < 0 ? blocks.length : firstAfter
  let from = 0
  for (let i = 0; i < to; i++) if (before.has(blocks[i].attrs.id)) from = i + 1
  const start = blocks.findIndex(block => block.attrs.id === draft.source?.headingId)
  if (start >= from && start < to) {
    const tracked = new Set(ids(baseline.blocks))
    while (from < start && !tracked.has(blocks[from].attrs.id)) from++
  }
  return { from, to }
}

// ProseMirror joins adjacent equally marked text and treats marks as a set.
// Apply the same comparison recursively to the saved, inactive wording.
function equivalentInlines(nodes: InlineJSON[] = []): InlineJSON[] {
  const runs: InlineJSON[] = []
  for (const node of nodes) {
    const marked = node as InlineJSON & { marks?: MarkJSON[] }
    const marks = [...new Set(marked.marks?.map(mark => mark.type))].sort().map(type => ({ type }))
    if (node.type === 'choice') {
      const options = node.attrs.options.map(option => ({ id: option.id, content: equivalentInlines(option.content) }))
      const { id, active } = node.attrs
      const group = { type: node.type, attrs: { id, active, options }, marks, content: equivalentInlines(node.content) }
      runs.push(group)
      continue
    }
    const previous = runs.at(-1)
    if (previous?.type === 'text' && isDeepStrictEqual(previous.marks, marks)) previous.text += node.text
    else runs.push({ type: 'text', text: node.text, marks })
  }
  return runs
}

function comparable(block: BlockJSON | null) {
  return block && { id: block.attrs.id, type: block.type, level: block.type === 'heading' ? block.attrs.level ?? 1 : null, content: equivalentInlines(block.content) }
}

// Insert blocks missing from the primary sequence before their nearest
// surviving successor. Paragraphs already present keep their relative order.
function unionOrder(primary: string[], secondary: string[]): string[] {
  const known = new Set(primary)
  const incoming = new Map<string, string[]>()
  let pending: string[] = []
  for (const id of secondary) {
    if (known.has(id)) {
      if (pending.length) incoming.set(id, pending)
      pending = []
    } else {
      pending.push(id)
    }
  }
  return primary.flatMap(id => [...(incoming.get(id) ?? []), id]).concat(pending)
}

function editable(blocks: BlockJSON[], placeholder: string): BlockJSON[] {
  return blocks.length ? blocks : [{ type: 'paragraph', attrs: { id: placeholder } }]
}

function orderedBlocks(order: string[], blocks: Map<string, BlockJSON>): BlockJSON[] {
  return order.filter(id => blocks.has(id)).map(id => blocks.get(id)!)
}

function setBlock(blocks: Map<string, BlockJSON>, id: string, value: BlockJSON | null) {
  if (value) blocks.set(id, structuredClone(value))
  else blocks.delete(id)
}

export function compareDraft(source: DocumentRecord, draft: DocumentRecord, baseline: DraftBaseline) {
  const range = sourceRange(source, draft, baseline)
  const placeholder = 'empty-' + draft.id
  const actual = (block: BlockJSON) => block.attrs.id !== placeholder || block.type !== 'paragraph' || !!block.content?.length
  const sourceBlocks = source.manuscript.content.slice(range.from, range.to).filter(actual)
  const draftBlocks = draft.manuscript.content.filter(actual)
  const tracked = new Set([...ids(baseline.blocks), ...ids(draftBlocks)])
  const displaced = source.manuscript.content.filter((block, index) => (index < range.from || index >= range.to) && tracked.has(block.attrs.id))
  const outside = new Set(ids(displaced))
  const original = byId(sourceBlocks)
  for (const block of displaced) original.set(block.attrs.id, block)
  const copy = byId(draftBlocks)
  const base = byId(baseline.blocks)
  const order = unionOrder(unionOrder(ids(sourceBlocks), ids(draftBlocks)), ids(baseline.blocks))
  const changes: DraftChange[] = []
  let agreed = false
  for (const id of order) {
    const a = original.get(id) ?? null
    const b = copy.get(id) ?? null
    const ancestor = base.get(id) ?? null
    const left = comparable(a)
    const right = comparable(b)
    const previous = comparable(ancestor)
    if (isDeepStrictEqual(left, right)) {
      if (!isDeepStrictEqual(left, previous)) {
        setBlock(base, id, a)
        agreed = true
      }
      continue
    }
    // A draft edit to a paragraph now in another chapter needs an explicit
    // decision, just like a simultaneous wording change in the original.
    const origin = isDeepStrictEqual(previous, right) ? 'original' : !outside.has(id) && isDeepStrictEqual(previous, left) ? 'draft' : 'conflict'
    const kind = !ancestor ? 'added' : !a || !b ? 'deleted' : 'modified'
    const revision = createHash('sha256').update(JSON.stringify([previous, left, right, outside.has(id)])).digest('hex')
    changes.push({ id, revision, origin, kind, baseline: ancestor, original: a, draft: b })
  }
  const latest = agreed ? { ...baseline, blocks: orderedBlocks(order, base) } : baseline
  return { changes, baseline: latest, range, order, original, copy, placeholder, outside }
}

export function reconcileDraft(source: DocumentRecord, draft: DocumentRecord, baseline: DraftBaseline, selections: DraftResolution[]) {
  const review = compareDraft(source, draft, baseline)
  const pending = new Map(review.changes.map(change => [change.id, change]))
  const reconciled = byId(review.baseline.blocks)
  for (const selection of selections) {
    const change = pending.get(selection.id)
    if (!change || change.revision !== selection.revision) throw Error('The paragraphs have changed. Reopen review to see the latest edits.')
    let result: BlockJSON | null
    if (selection.choice === 'original') result = change.original
    else if (selection.choice === 'draft') result = change.draft
    else if (selection.choice === 'edited' && selection.block !== undefined) result = selection.block
    else throw Error('Choose the result for this paragraph.')
    if (result && result.attrs.id !== change.id) throw Error('The edited result must keep its paragraph ID.')
    for (const blocks of [review.original, review.copy, reconciled]) setBlock(blocks, change.id, result)
    pending.delete(change.id)
  }
  const sourceContent = source.manuscript.content
  const originalOrder = unionOrder(ids(sourceContent.slice(review.range.from, review.range.to)), review.order)
  const draftOrder = unionOrder(ids(draft.manuscript.content), review.order)
  // Resolve displaced IDs once at their current position. Unrelated sibling
  // paragraphs remain in their original order and never enter the draft.
  function surrounding(blocks: BlockJSON[]) {
    return blocks.flatMap(block => {
      if (!review.outside.has(block.attrs.id)) return [block]
      const updated = review.original.get(block.attrs.id)
      return updated ? [updated] : []
    })
  }
  const inside = orderedBlocks(originalOrder.filter(id => !review.outside.has(id)), review.original)
  const full = [...surrounding(sourceContent.slice(0, review.range.from)), ...inside, ...surrounding(sourceContent.slice(review.range.to))]
  return {
    source: { ...source, manuscript: { ...source.manuscript, content: editable(full, review.placeholder) } },
    draft: { ...draft, manuscript: { ...draft.manuscript, content: editable(orderedBlocks(draftOrder, review.copy), review.placeholder) } },
    baseline: { ...review.baseline, blocks: orderedBlocks(review.order, reconciled) }
  }
}
