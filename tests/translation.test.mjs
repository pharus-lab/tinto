import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// The translator runs in Electron's main process; here it runs in Node with a
// stand-in for electron and a simulated OpenAI.
const electron = { name: 'electron', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = {}, ipcMain = {}, safeStorage = {}' }))
} }
const bundle = await build({ stdin: { contents: "export * from './src/translation'; export * from './src/translator'", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false, plugins: [electron] })
const { translationSource, translationParts, parseTagged, translatedManuscript, taggedText, createTranslator } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const text = (value, ...marks) => marks.length ? { type: 'text', text: value, marks: marks.map(type => ({ type })) } : { type: 'text', text: value }
const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { id: 'h', level: 2 }, content: [text('A & B')] },
  { type: 'paragraph', attrs: { id: 'a' }, content: [text('The '), text('quiet', 'strong', 'em'), text(' house <'), text('rain', 'highlight', 'origin')] },
  { type: 'paragraph', attrs: { id: 'blank' }, content: [text('   ')] },
  { type: 'paragraph', attrs: { id: 'b' }, content: [text('She chose '), { type: 'choice', attrs: { id: 'c', active: 'o2', options: [{ id: 'o1', content: [text('tea')] }, { id: 'o2' }] }, content: [text('cake', 'em')] }, text('.')] }
] }
doc.content[1].content[3].marks[1] = { type: 'origin', attrs: { source: 'pasted' } }

test('a manuscript travels as its chosen wording, with bold, italic and underline as tags, and comes back marked as AI', () => {
  const source = translationSource(doc, 'Title')
  assert.deepEqual(source, { title: 'Title', blocks: [
    { id: 'p1', text: 'A &amp; B' },
    { id: 'p2', text: 'The <b><i>quiet</i></b> house &lt;<u>rain</u>' },
    { id: 'p4', text: 'She chose <i>cake</i>.' }
  ] }, 'blank paragraphs stay home, unchosen wordings are not sent, origins are not tags')
  assert.equal(taggedText(doc.content[3]), 'She chose <i>cake</i>.')

  assert.deepEqual(parseTagged('Un <b><i>tranquilo</i></b> &lt;hogar&gt; <u>lluvia</u> </i>fin'), [
    text('Un '), text('tranquilo', 'strong', 'em'), text(' <hogar> '), text('lluvia', 'highlight'), text(' fin')
  ], 'an unmatched closing tag is ignored')
  assert.deepEqual(parseTagged('<b>a</b><b>b</b>'), [text('ab', 'strong')], 'runs with the same marks join')

  const result = { title: 'Título', blocks: [{ id: 'p1', text: 'A y B' }, { id: 'p2', text: 'La casa <b><i>tranquila</i></b>' }, { id: 'p4', text: 'Ella eligió <i>pastel</i>.' }] }
  const translated = translatedManuscript(doc, source, result)
  assert.deepEqual(translated.content.map(block => [block.type, block.attrs.level ?? null]), [['heading', 2], ['paragraph', null], ['paragraph', null], ['paragraph', null]])
  assert.ok(translated.content.every((block, index) => block.attrs.id !== doc.content[index].attrs.id), 'a translation has its own ids')
  assert.equal(translated.content[2].content, undefined, 'the blank paragraph stays blank')
  const ai = { type: 'origin', attrs: { source: 'ai' } }
  assert.deepEqual(translated.content[1].content, [{ type: 'text', text: 'La casa ' , marks: [ai] }, { type: 'text', text: 'tranquila', marks: [{ type: 'strong' }, { type: 'em' }, ai] }])

  for (const broken of [result.blocks.slice(0, 2), [...result.blocks, { id: 'p9', text: 'extra' }], [result.blocks[0], result.blocks[0], result.blocks[2]]]) {
    assert.throws(() => translatedManuscript(doc, source, { title: 'T', blocks: broken }), /The translation lost or merged paragraphs/)
  }

  const words = n => ({ id: 'x' + n, text: Array(n).fill('word').join(' ') })
  assert.deepEqual(translationParts([words(2000), words(900), words(400), words(5000), words(10)]).map(part => part.map(block => block.id)), [['x2000', 'x900'], ['x400'], ['x5000'], ['x10']])
})

test('the translator asks OpenAI for a strict schema without storing the text, and explains each failure', async () => {
  const sent = []
  let replies = []
  const fetcher = async (url, init) => {
    sent.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  const message = output => ({ body: { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } })
  const translator = createTranslator({ provider: 'openai', key: 'sk-test-0123456789abcdefghij', model: 'gpt-6.2-astra' }, fetcher)

  replies = [{ body: { id: 'gpt-6.2-astra' } }]
  await translator.check()
  assert.equal(sent[0].url, 'https://api.openai.com/v1/models/gpt-6.2-astra')
  assert.equal(sent[0].init.headers.Authorization, 'Bearer sk-test-0123456789abcdefghij')

  sent.length = 0
  const blocks = Array.from({ length: 3 }, (_, index) => ({ id: 'p' + (index + 1), text: Array(1600).fill('word').join(' ') }))
  replies = [message({ title: 'Título', blocks: blocks.slice(0, 1).map(block => ({ ...block, text: 'uno' })) }), message({ title: 'ignored', blocks: blocks.slice(1, 2).map(block => ({ ...block, text: 'dos' })) }), message({ title: 'ignored', blocks: blocks.slice(2).map(block => ({ ...block, text: 'tres' })) })]
  const progress = []
  const result = await translator.translate({ title: 'Title', blocks }, 'en', 'es', (done, total) => progress.push(done + '/' + total))
  assert.deepEqual(result, { title: 'Título', blocks: [{ id: 'p1', text: 'uno' }, { id: 'p2', text: 'dos' }, { id: 'p3', text: 'tres' }] })
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3'])
  const request = sent[0].body
  assert.equal(sent[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(request.model, 'gpt-6.2-astra')
  assert.equal(request.store, false)
  assert.equal(request.max_output_tokens, 32000)
  assert.match(request.instructions, /^You translate a writer's manuscript from English into Mexican Spanish for publication\./)
  assert.deepEqual(JSON.parse(request.input), { title: 'Title', blocks: [blocks[0]] })
  assert.equal(request.text.format.type, 'json_schema')
  assert.equal(request.text.format.strict, true)
  assert.deepEqual(request.text.format.schema.required, ['title', 'blocks'])
  assert.equal(request.text.format.schema.additionalProperties, false)

  replies = [message({ texts: ['Un resumen', 'otro'] })]
  assert.deepEqual(await translator.translateTexts(['A summary', '', 'another'].filter(Boolean), 'en', 'es'), ['Un resumen', 'otro'])
  assert.deepEqual(await translator.translateTexts(['', ' '], 'en', 'es'), ['', ' '], 'nothing to translate sends nothing')

  const failures = [
    [{ status: 401, body: { error: { code: 'invalid_api_key' } } }, /OpenAI rejected the API key/],
    [{ status: 404, body: { error: { code: 'model_not_found' } } }, /OpenAI has no model named gpt-6.2-astra/],
    [{ status: 429, body: { error: { code: 'insufficient_quota' } } }, /no credit left/],
    [{ status: 429, body: { error: { code: 'rate_limit_exceeded' } } }, /limiting requests/],
    [{ body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }, /longer than OpenAI could return at once/],
    [{ body: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] } }, /OpenAI declined to translate this text: No\./],
    [{ body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] } }, /could not read/]
  ]
  for (const [reply, expected] of failures) {
    replies = [reply]
    await assert.rejects(translator.translateTexts(['x'], 'en', 'es'), expected)
  }
  // A busy service and a dropped connection each get one more try.
  replies = [{ status: 503, body: {} }, message({ texts: ['y'] })]
  assert.deepEqual(await translator.translateTexts(['x'], 'en', 'es'), ['y'])
  replies = [new TypeError('fetch failed'), new TypeError('fetch failed')]
  await assert.rejects(translator.translateTexts(['x'], 'en', 'es'), /Tinto could not reach OpenAI/)
})

test('Claude translates through Anthropic\'s SDK with a JSON format, and OpenRouter only with models that keep the schema', async () => {
  const sent = []
  let replies = []
  const fetcher = async (url, init = {}) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    const reply = replies.shift()
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  const answer = (texts, stop = 'end_turn') => ({ body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ texts }) }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } })
  const claude = model => createTranslator({ provider: 'anthropic', key: 'sk-ant-test-0123456789abcdefghij', model }, fetcher)

  replies = [{ body: { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z' } }]
  await claude('claude-opus-5-5').check()
  assert.match(sent[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models\/claude-opus-5-5/)
  assert.ok([...sent[0].headers.values()].some(value => value.includes('sk-ant-test-0123456789abcdefghij')), 'the key goes with the request')

  sent.length = 0
  replies = [answer(['Hola'])]
  assert.deepEqual(await claude('claude-opus-5-5').translateTexts(['Hello'], 'en', 'es'), ['Hola'])
  const request = sent[0].body
  assert.match(sent[0].url, /\/v1\/messages/)
  assert.deepEqual([request.model, request.max_tokens, request.output_config.format.type, request.output_config.effort, request.fallbacks], ['claude-opus-5-5', 16000, 'json_schema', 'medium', 'default'])
  assert.match(request.system, /^Translate each text from English into Mexican Spanish/)
  assert.deepEqual(JSON.parse(request.messages[0].content), { texts: ['Hello'] })
  assert.match(sent[0].headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/)
  // Sonnet 5.5 also takes the fallback; an older model gets neither effort nor fallback.
  replies = [answer(['Hola'])]
  await claude('claude-sonnet-5-5').translateTexts(['Hello'], 'en', 'es')
  assert.equal(sent.at(-1).body.fallbacks, 'default')
  replies = [answer(['Hola'])]
  await claude('claude-haiku-4-5').translateTexts(['Hello'], 'en', 'es')
  assert.deepEqual([sent.at(-1).body.fallbacks, sent.at(-1).body.output_config.effort], [undefined, undefined])

  replies = [answer(['x'], 'refusal')]
  await assert.rejects(claude('claude-opus-5-5').translateTexts(['Hello'], 'en', 'es'), /Claude declined to translate this text/)
  replies = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]
  await assert.rejects(claude('claude-opus-5-5').translateTexts(['Hello'], 'en', 'es'), /Anthropic rejected the API key/)

  // OpenRouter: the key, then a model that exists and keeps a strict schema.
  const router = model => createTranslator({ provider: 'openrouter', key: 'sk-or-test-0123456789abcdefghij', model }, fetcher)
  const models = { body: { data: [{ id: 'openai/gpt-6.2-astra', supported_parameters: ['structured_outputs', 'response_format'] }, { id: 'someone/plain', supported_parameters: ['temperature'] }] } }
  sent.length = 0
  replies = [{ body: { data: { label: 'key' } } }, models]
  await router('openai/gpt-6.2-astra').check()
  assert.deepEqual(sent.map(item => item.url), ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models'])
  replies = [{ body: { data: {} } }, models]
  await assert.rejects(router('openai/gpt-0').check(), /OpenRouter has no model named openai\/gpt-0/)
  replies = [{ body: { data: {} } }, models]
  await assert.rejects(router('someone/plain').check(), /does not return structured output on OpenRouter/)
  replies = [{ body: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ texts: ['Hola'] }) }] }] } }]
  assert.deepEqual(await router('openai/gpt-6.2-astra').translateTexts(['Hello'], 'en', 'es'), ['Hola'])
  assert.equal(sent.at(-1).url, 'https://openrouter.ai/api/v1/responses')
  assert.deepEqual([sent.at(-1).body.store, sent.at(-1).body.provider], [false, { require_parameters: true }])
  replies = [{ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } }]
  await assert.rejects(router('openai/gpt-6.2-astra').translateTexts(['Hello'], 'en', 'es'), /Your OpenRouter account has no credit left/)
})
