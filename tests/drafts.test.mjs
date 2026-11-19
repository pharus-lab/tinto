import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/storage.ts'], platform: 'node', format: 'esm', bundle: true, write: false })
const { ProjectStore } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const text = value => ({ type: 'text', text: value })
const paragraph = (id, value) => ({ type: 'paragraph', attrs: { id }, content: [text(value)] })
const heading = id => ({ type: 'heading', attrs: { id, level: 1 }, content: [text(id)] })
const choose = (change, choice, block) => ({ id: change.id, revision: change.revision, choice, block })
const block = (doc, id) => doc.manuscript.content.find(item => item.attrs.id === id)
const ids = doc => doc.manuscript.content.map(item => item.attrs.id)

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tinto-draft-'))
  const path = join(dir, 'drafts.tinto')
  const choice = { type: 'choice', attrs: { id: 'food', active: 'b', options: [{ id: 'a', content: [text('ice cream')] }, { id: 'b' }] }, content: [text('cake')] }
  const food = { ...paragraph('food', ''), content: [choice] }
  const content = [heading('Before'), paragraph('intro', 'First.'), heading('Kitchen'), food, paragraph('b', 'Rain.'), heading('Garden'), paragraph('outside', 'Morning.')]
  const source = { id: 'original', title: 'Stories', language: 'es', manuscript: { type: 'doc', content } }
  let store = ProjectStore.create(path, 'Collection', source)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return {
    source, get store() { return store },
    reopen() { store.close(); store = new ProjectStore(path) },
    simulateV1() {
      store.close()
      const db = new DatabaseSync(path)
      db.exec('DROP TABLE draft_baselines; PRAGMA user_version = 1')
      db.close()
      store = new ProjectStore(path)
    }
  }
}

test('partial application preserves conflicts, survives reopening, and advances each accepted baseline', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Chapter revision')
  assert.equal(draft.language, 'es')
  assert.deepEqual(draft.source, { documentId: f.source.id, headingId: 'Kitchen' })
  assert.deepEqual(ids(draft), ['Kitchen', 'food', 'b'])
  block(draft, 'food').content[0].attrs.options[0].content = [text('sorbet')]
  block(draft, 'b').content = [text('Draft rain.')]
  f.store.save(draft)
  block(f.source, 'b').content = [text('Original rain.')]
  f.store.save(f.source)
  const [hidden, conflict] = f.store.reviewDraft(draft.id)
  assert.equal(hidden.origin, 'draft')
  assert.deepEqual(hidden.original.content[0].content, hidden.draft.content[0].content)
  assert.equal(conflict.origin, 'conflict')
  const result = f.store.applyDraft(draft.id, [choose(hidden, 'draft')])
  assert.deepEqual(block(result.source, 'food'), block(draft, 'food'))
  assert.equal(block(result.source, 'b').content[0].text, 'Original rain.')
  f.reopen()
  assert.deepEqual(f.store.reviewDraft(draft.id), [conflict])
  const edited = paragraph('b', 'New rain.')
  const resolved = f.store.applyDraft(draft.id, [choose(conflict, 'edited', edited)])
  assert.deepEqual(block(resolved.source, 'b'), edited)
  assert.deepEqual(block(resolved.draft, 'b'), edited)
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
  block(resolved.draft, 'b').content = [text('Newer rain.')]
  f.store.save(resolved.draft)
  const [next] = f.store.reviewDraft(draft.id)
  assert.equal(next.origin, 'draft')
  assert.deepEqual(next.baseline, edited)
})

test('a hidden edit conflicts with an active switch and stale multi-change resolutions are atomic', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Hidden wording')
  block(draft, 'food').content[0].attrs.options[0].content[0].marks = [{ type: 'strong' }]
  block(draft, 'b').content = [text('Different.')]
  f.store.save(draft)
  const food = block(f.source, 'food').content[0]
  food.attrs.active = 'a'
  food.attrs.options = [{ id: 'a' }, { id: 'b', content: [text('cake')] }]
  food.content = [text('ice cream')]
  f.store.save(f.source)
  const [conflict, simple] = f.store.reviewDraft(draft.id)
  assert.equal(conflict.origin, 'conflict')
  block(f.source, 'food').content[0].content = [text('frozen yogurt')]
  f.store.save(f.source)
  const before = f.store.read()
  assert.throws(() => f.store.applyDraft(draft.id, [choose(simple, 'draft'), choose(conflict, 'original')]), /Reopen review/)
  assert.deepEqual(f.store.read(), before)
  const [latest] = f.store.reviewDraft(draft.id)
  const { draft: synced } = f.store.applyDraft(draft.id, [choose(latest, 'original')])
  assert.deepEqual(block(synced, 'food'), block(f.source, 'food'))
  assert.deepEqual(f.store.reviewDraft(draft.id), [simple])
})

test('additions, deletions and original-only changes keep their positions inside the section', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Order')
  draft.manuscript.content.splice(1, 1, paragraph('x', 'New one.'), paragraph('y', 'New two.'))
  f.store.save(draft)
  f.source.manuscript.content.splice(4, 0, paragraph('original-add', 'Another.'))
  block(f.source, 'Kitchen').content = [text('Supper')]
  f.store.save(f.source)
  const changes = f.store.reviewDraft(draft.id)
  assert.equal(changes.find(change => change.id === 'food').kind, 'deleted')
  assert.equal(changes.find(change => change.id === 'original-add').origin, 'original')
  const resolve = change => choose(change, change.origin)
  f.store.applyDraft(draft.id, [resolve(changes.find(change => change.id === 'y'))])
  const final = f.store.applyDraft(draft.id, f.store.reviewDraft(draft.id).map(resolve))
  assert.deepEqual(ids(final.source), ['Before', 'intro', ...ids(final.draft), 'Garden', 'outside'])
  assert.ok(ids(final.draft).indexOf('x') < ids(final.draft).indexOf('y'))
  assert.equal(block(final.draft, 'Kitchen').content[0].text, 'Supper')
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
})

test('a deleted source heading and skipped additions stay tied to the original section', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Change opening')
  draft.manuscript.content.shift()
  draft.manuscript.content.push(paragraph('last', 'Dessert.'))
  f.store.save(draft)
  const [deleted, addition] = f.store.reviewDraft(draft.id)
  f.store.applyDraft(draft.id, [choose(deleted, 'draft')])
  f.reopen()
  assert.deepEqual(f.store.reviewDraft(draft.id), [addition])
  const result = f.store.applyDraft(draft.id, [choose(addition, 'draft')])
  assert.deepEqual(ids(result.source), ['Before', 'intro', 'food', 'b', 'last', 'Garden', 'outside'])
})

test('a version-one project upgrades in place and keeps its documents and named versions', t => {
  const f = project(t)
  f.store.snapshot(f.source.id, 'Before migration')
  const before = f.store.read()
  f.simulateV1()
  assert.deepEqual(f.store.read(), before)
  assert.equal(f.store.versions(f.source.id)[0].name, 'Before migration')
  const draft = f.store.createDraft(f.source.id, null, 'Whole manuscript')
  assert.deepEqual(draft.manuscript, f.source.manuscript)
  f.store.snapshot(draft.id, 'Draft only')
  f.reopen()
  assert.equal(f.store.versions(draft.id)[0].name, 'Draft only')
  assert.equal(f.store.versions(f.source.id).length, 1)
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
})

test('matching edits establish a new baseline before a later original-only change', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Shared wording')
  for (const doc of [draft, f.source]) {
    block(doc, 'b').content = [text('It was raining.')]
    f.store.save(doc)
  }
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
  f.reopen()
  block(f.source, 'b').content = [text('It was pouring.')]
  f.store.save(f.source)
  const [proposed] = f.store.reviewDraft(draft.id)
  assert.equal(proposed.origin, 'original')
  assert.deepEqual(proposed.baseline, block(draft, 'b'))
})

test('a new sibling chapter stays outside review and a displaced paragraph reconciles in place', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Kitchen revision')
  block(draft, 'b').content = [text('Draft rain.')]
  draft.manuscript.content.splice(2, 0, paragraph('draft-add', 'Something for the kitchen.'))
  f.store.save(draft)
  const [addition, oldEdit] = f.store.reviewDraft(draft.id)
  f.source.manuscript.content.splice(4, 0, heading('Middle'), paragraph('sibling', 'A separate story.'))
  f.store.save(f.source)
  const current = f.store.reviewDraft(draft.id)
  assert.deepEqual(current.map(change => change.id).sort(), ['b', 'draft-add'])
  const moved = current.find(change => change.id === 'b')
  assert.equal(moved.origin, 'conflict')
  assert.notEqual(moved.revision, oldEdit.revision)
  assert.throws(() => f.store.applyDraft(draft.id, [choose(oldEdit, 'draft')]), /Reopen review/)
  const result = f.store.applyDraft(draft.id, [choose(addition, 'draft'), choose(moved, 'draft')])
  assert.deepEqual(ids(result.source), ['Before', 'intro', 'Kitchen', 'food', 'draft-add', 'Middle', 'sibling', 'b', 'Garden', 'outside'])
  assert.equal(block(result.source, 'sibling').content[0].text, 'A separate story.')
  assert.equal(block(result.source, 'b').content[0].text, 'Draft rain.')
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
})

test('applying a draft heading and its paragraphs keeps them available after the section splits', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Extended kitchen')
  draft.manuscript.content.push(heading('Dessert'), paragraph('sweet', 'Cake.'))
  f.store.save(draft)
  const first = f.store.applyDraft(draft.id, f.store.reviewDraft(draft.id).map(change => choose(change, 'draft')))
  first.draft.manuscript.content.push(paragraph('last', 'Tea.'))
  f.store.save(first.draft)
  const [addition] = f.store.reviewDraft(draft.id)
  const next = f.store.applyDraft(draft.id, [choose(addition, 'draft')])
  assert.deepEqual(ids(next.source), ['Before', 'intro', 'Kitchen', 'food', 'b', 'Dessert', 'sweet', 'last', 'Garden', 'outside'])
  assert.deepEqual(f.store.reviewDraft(draft.id), [])
})

test('equivalent DOCX text runs and mark order produce no draft changes, including hidden options', t => {
  const f = project(t)
  const marks = [{ type: 'em' }, { type: 'strong' }]
  const split = ['hot ', 'tea'].map(value => ({ ...text(value), marks }))
  block(f.source, 'b').content = split
  block(f.source, 'food').content[0].attrs.options[0].content = split
  f.store.save(f.source)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'Edited in the writing area')
  const normalized = [{ ...text('hot tea'), marks: [...marks].reverse() }]
  block(draft, 'b').content = normalized
  block(draft, 'food').content[0].attrs.options[0].content = normalized
  block(draft, 'Kitchen').content = [text('Supper')]
  f.store.save(draft)
  const changes = f.store.reviewDraft(draft.id)
  assert.deepEqual(changes.map(change => change.id), ['Kitchen'])
  f.store.applyDraft(draft.id, [choose(changes[0], 'draft')])
  block(draft, 'food').content[0].attrs.options[0].content = [{ ...text('hot tea'), marks: [{ type: 'em' }] }]
  f.store.save(draft)
  const [hidden] = f.store.reviewDraft(draft.id)
  assert.equal(hidden.id, 'food')
  assert.equal(hidden.origin, 'draft')
})

test('accepting a deletion before its replacement keeps an empty draft editable', t => {
  const f = project(t)
  const draft = f.store.createDraft(f.source.id, 'Kitchen', 'New passage')
  draft.manuscript.content = [paragraph('replacement', 'Something new.')]
  f.store.save(draft)
  // The original author has also taken out the old text. Keep its single
  // remaining heading in the original until the later addition is accepted.
  f.source.manuscript.content = f.source.manuscript.content.filter(item => !['food', 'b'].includes(item.attrs.id))
  f.store.save(f.source)
  const changes = f.store.reviewDraft(draft.id)
  const added = changes.find(change => change.id === 'replacement')
  const rejected = f.store.applyDraft(draft.id, [choose(added, 'original')])
  assert.equal(rejected.draft.manuscript.content.length, 1)
  assert.equal(rejected.draft.manuscript.content[0].type, 'paragraph')
  assert.deepEqual(f.store.reviewDraft(draft.id).map(change => change.id), ['Kitchen'])
  rejected.draft.manuscript.content[0].content = [text('Try again.')]
  f.store.save(rejected.draft)
  const pending = f.store.reviewDraft(draft.id)
  assert.equal(pending.filter(change => change.kind === 'added').length, 1)
})
