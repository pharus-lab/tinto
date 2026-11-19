import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { sectionRange, type BlockJSON } from './model'
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
  const original = byId(sourceBlocks)
  const copy = byId(draftBlocks)
  const base = byId(baseline.blocks)
  const order = unionOrder(unionOrder(ids(sourceBlocks), ids(draftBlocks)), ids(baseline.blocks))
  const changes: DraftChange[] = []
  let agreed = false
  for (const id of order) {
    const a = original.get(id) ?? null
    const b = copy.get(id) ?? null
    const ancestor = base.get(id) ?? null
    if (isDeepStrictEqual(a, b)) {
      if (!isDeepStrictEqual(a, ancestor)) {
        setBlock(base, id, a)
        agreed = true
      }
      continue
    }
    const origin = isDeepStrictEqual(ancestor, a) ? 'draft' : isDeepStrictEqual(ancestor, b) ? 'original' : 'conflict'
    const kind = !ancestor ? 'added' : !a || !b ? 'deleted' : 'modified'
    const revision = createHash('sha256').update(JSON.stringify([ancestor, a, b])).digest('hex')
    changes.push({ id, revision, origin, kind, baseline: ancestor, original: a, draft: b })
  }
  const latest = agreed ? { ...baseline, blocks: orderedBlocks(order, base) } : baseline
  return { changes, baseline: latest, range, order, original, copy, placeholder }
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
  const full = [...sourceContent.slice(0, review.range.from), ...orderedBlocks(originalOrder, review.original), ...sourceContent.slice(review.range.to)]
  return {
    source: { ...source, manuscript: { ...source.manuscript, content: editable(full, review.placeholder) } },
    draft: { ...draft, manuscript: { ...draft.manuscript, content: editable(orderedBlocks(draftOrder, review.copy), review.placeholder) } },
    baseline: { ...review.baseline, blocks: orderedBlocks(review.order, reconciled) }
  }
}
