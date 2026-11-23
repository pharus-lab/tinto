import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// The writing coach runs in Electron's main process; here it runs in Node with
// a stand-in for electron and simulated AI services.
const electron = { name: 'electron', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = {}, ipcMain = {}, safeStorage = {}' }))
} }
const bundle = await build({ stdin: { contents: "export * from './src/writing-coach'; export { createTranslator } from './src/translator'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false, plugins: [electron] })
const { anchorNotes, coachInstructions, coachParts, validateCoachRequest, COACH_SCHEMA, COACH_KINDS, COACH_LIMIT, createTranslator } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const note = (block, quote, extra = {}) => ({ block, quote, kind: 'punctuation', title: 'Comma splice', explanation: 'Two sentences are joined by a comma.', suggestion: 'Use a period or a semicolon. For example: "I went to the store. I bought bread."', ...extra })

test('the coach is told to coach, not edit, in each dialect, and to answer in the document\'s language', () => {
  const us = coachInstructions('en'), uk = coachInstructions('en-GB'), mx = coachInstructions('es')
  for (const text of [us, uk, mx]) {
    assert.match(text, /You do not edit or rewrite the text/)
    assert.match(text, /copied exactly, character for character/)
    assert.match(text, /Oxford comma/)
  }
  assert.match(us, /American English/)
  assert.match(us, /Write the title, explanation and suggestion in English\./)
  assert.match(uk, /British English/)
  assert.match(uk, /Do not flag British spellings/)
  assert.match(mx, /Mexican Spanish/)
  assert.match(mx, /RAE and ASALE as used in Mexico/)
  assert.match(mx, /ustedes rather than vosotros/)
  assert.match(mx, /"Por ejemplo:"/)
  assert.match(mx, /Write the title, explanation and suggestion in Spanish\./)
  // A strict schema: every field required, nothing else allowed, a fixed set of kinds.
  const item = COACH_SCHEMA.properties.notes.items
  assert.deepEqual(item.required, ['block', 'quote', 'kind', 'title', 'explanation', 'suggestion'])
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.properties.kind.enum, [...COACH_KINDS])
})

test('notes are placed only on passages they quote exactly, once each', () => {
  const blocks = [{ id: 'p1', text: 'I went to the store, I bought bread. It’s late, it’s dark.' }, { id: 'p2', text: 'The  report it was   written badly.' }]
  const { notes, dropped } = anchorNotes(blocks, [
    note('p1', 'I went to the store, I bought bread.'),
    note('p1', "It's late, it's dark."), // straight apostrophes for curly ones
    note('p2', 'The report it was written badly.', { kind: 'syntax' }), // collapsed spaces
    note('p1', 'This sentence is not there.'),
    note('p9', 'I went to the store'),
    note('p1', 'I went to the store, I bought bread.'), // the same note again
    note('p1', 'bread', { kind: 'nonsense' }),
    { block: 'p1', quote: 7 },
    note('p1', '   ')
  ])
  assert.equal(dropped, 6)
  assert.deepEqual(notes.map(n => [n.block, n.quote, n.kind]), [
    ['p1', 'I went to the store, I bought bread.', 'punctuation'],
    ['p1', 'It’s late, it’s dark.', 'punctuation'],
    ['p2', 'The  report it was   written badly.', 'syntax']
  ])
  for (const n of notes) assert.equal(blocks.find(b => b.id === n.block).text.slice(n.from, n.to), n.quote)
  // Long fields are clipped; an empty title falls back to the kind.
  const [clipped] = anchorNotes(blocks, [note('p1', 'bread', { title: '', explanation: 'x'.repeat(2000), suggestion: '' })]).notes
  assert.equal(clipped.title, 'Punctuation')
  assert.equal(clipped.explanation.length, 600)
  assert.equal(clipped.suggestion, '')
})

test('a review is bounded, skips empty blocks, and is split into parts of whole blocks', () => {
  assert.throws(() => validateCoachRequest(null), /Nothing to review/)
  assert.throws(() => validateCoachRequest({ language: 'fr', blocks: [{ id: 'p1', text: 'Bonjour.' }] }), /Nothing to review/)
  assert.throws(() => validateCoachRequest({ language: 'en', blocks: [{ id: 'p1', text: '  ' }] }), /Nothing to review/)
  assert.throws(() => validateCoachRequest({ language: 'en', blocks: [{ id: 'p1', text: 'a' }, { id: 'p1', text: 'b' }] }), /Nothing to review/)
  assert.throws(() => validateCoachRequest({ language: 'en', blocks: [{ id: 'p1', text: 'x'.repeat(COACH_LIMIT + 1) }] }), /up to about 10,000 words/)
  const request = validateCoachRequest({ language: 'es', blocks: [{ id: 'p1', text: 'Hola.' }, { id: 'p2', text: '' }, { id: 'p3', text: 'Adiós.', extra: true }] })
  assert.deepEqual(request, { language: 'es', blocks: [{ id: 'p1', text: 'Hola.' }, { id: 'p3', text: 'Adiós.' }] })
  const parts = coachParts(Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, text: 'w'.repeat(5000) })))
  assert.deepEqual(parts.map(part => part.map(block => block.id)), [['p0', 'p1'], ['p2', 'p3'], ['p4']])
})

test('OpenAI, OpenRouter and Claude are asked for the strict schema, without storing the text, and explain failures as a review', async () => {
  const sent = []
  let replies = []
  const fetcher = async (url, init = {}) => {
    sent.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    const reply = replies.shift()
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  const blocks = [{ id: 'p1', text: 'I went to the store, I bought bread.' }]
  const output = notes => ({ body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ notes }) }] }] } })

  const openai = createTranslator({ provider: 'openai', key: 'sk-test-0123456789abcdefghij', model: 'gpt-6.2-astra' }, fetcher)
  replies = [output([note('p1', 'I went to the store, I bought bread.'), note('p1', 'invented')])]
  const progress = []
  const result = await openai.coach({ language: 'en-GB', blocks }, (done, total) => progress.push(done + '/' + total))
  assert.equal(result.provider, 'OpenAI')
  assert.equal(result.model, 'gpt-6.2-astra')
  assert.equal(result.dropped, 1)
  assert.deepEqual(result.notes.map(n => [n.quote, n.from, n.to]), [['I went to the store, I bought bread.', 0, 36]])
  assert.deepEqual(progress, ['0/1', '1/1'])
  const request = sent[0].body
  assert.equal(sent[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(request.store, false)
  assert.equal(request.text.format.type, 'json_schema')
  assert.equal(request.text.format.strict, true)
  assert.equal(request.text.format.name, 'coaching')
  assert.match(request.instructions, /British English/)
  assert.deepEqual(JSON.parse(request.input), { blocks })

  for (const [reply, message] of [
    [{ status: 401, body: { error: {} } }, /OpenAI rejected the API key\. Check it in Settings → Writing → AI service\./],
    [{ status: 429, body: { error: {} } }, /Wait a minute and check again\./],
    [{ status: 402, body: { error: {} } }, /Add credit, then check again\./],
    [{ body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }, /The writing coach had more to say than OpenAI could return at once\. Check a shorter section\./],
    [{ body: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] } }, /OpenAI declined to review this text: No\./],
    [{ body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] } }, /The writing coach's answer came back in a form Tinto could not read\. Check again\./],
    [output('not a list'), /could not read/]
  ]) {
    replies = [reply]
    await assert.rejects(openai.coach({ language: 'en', blocks }), message)
  }

  sent.length = 0
  const router = createTranslator({ provider: 'openrouter', key: 'sk-or-test-0123456789abcdefghij', model: 'openai/gpt-6.2-astra' }, fetcher)
  replies = [output([])]
  assert.deepEqual((await router.coach({ language: 'es', blocks: [{ id: 'p1', text: 'Hola, mundo.' }] })).notes, [])
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/responses')
  assert.deepEqual(sent[0].body.provider, { require_parameters: true })
  assert.match(sent[0].body.instructions, /Mexican Spanish/)

  sent.length = 0
  const claude = createTranslator({ provider: 'anthropic', key: 'sk-ant-test-0123456789abcdefghij', model: 'claude-opus-5-5' }, fetcher)
  const answer = (notes, stop = 'end_turn') => ({ body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ notes }) }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } })
  replies = [answer([note('p1', 'I bought bread', { kind: 'grammar' })])]
  const reviewed = await claude.coach({ language: 'en', blocks })
  assert.deepEqual(reviewed.notes.map(n => [n.quote, n.kind]), [['I bought bread', 'grammar']])
  assert.equal(sent[0].body.output_config.format.type, 'json_schema')
  assert.deepEqual(sent[0].body.output_config.format.schema, COACH_SCHEMA)
  assert.match(sent[0].body.system, /American English/)
  replies = [answer([], 'refusal')]
  await assert.rejects(claude.coach({ language: 'en', blocks }), /Claude declined to review this text\./)
  replies = [answer([], 'max_tokens')]
  await assert.rejects(claude.coach({ language: 'en', blocks }), /The writing coach had more to say than Claude could return at once\./)
})
