import assert from 'node:assert/strict'
import test from 'node:test'
import { writingService } from './writing-fixture.mjs'

const request = (text, extra = {}) => ({ language: 'en', spelling: true, grammar: true, words: [], disabledRules: [], blocks: [{ id: 'test', text }], ...extra })

test('the bundled worker checks English, Unicode offsets, dialects, Spanish and category filters offline', async t => {
  const service = writingService(t)
  const check = async (text, extra) => (await service.check(request(text, extra))).blocks[0].diagnostics
  const text = '😀 Cafe\u0301. This is a example. She go home. I want creem. The the dog is very unique.'
  const diagnostics = await check(text)
  for (const item of diagnostics) assert.equal(text.slice(item.from, item.to), item.source)
  assert.ok(diagnostics.some(d => d.rule === 'AnA'))
  assert.ok(diagnostics.some(d => d.rule === 'PronounVerbAgreement'))
  assert.ok(diagnostics.some(d => d.source === 'creem' && d.replacements.some(r => r.text === 'cream')))
  assert.ok(diagnostics.some(d => d.rule === 'RepeatedWords'))
  assert.ok(!diagnostics.some(d => d.rule === 'VeryUnique' || d.category === 'Style'), 'style advice waits for style hints')
  assert.ok((await check('I want creem. She go home.', { spelling: false })).every(d => d.category !== 'Spelling'))
  assert.ok((await check('I want creem. She go home.', { grammar: false })).every(d => d.category === 'Spelling'))
  assert.deepEqual(await check('I want creem. She go home.', { grammar: false, spelling: false }), [])
  assert.ok(!(await check('This is a example.', { disabledRules: ['AnA'] })).some(d => d.rule === 'AnA'))
  assert.ok(!(await check('I want creem.', { words: ['creem'] })).some(d => d.source === 'creem'))
  assert.ok((await check('I want creem.')).some(d => d.source === 'creem'), 'removing accepted words takes effect')
  assert.ok(!(await check('The colour is lovely.', { language: 'en-GB' })).some(d => d.category === 'Spelling'))
  assert.ok((await check('The colour is lovely.', { language: 'en' })).some(d => d.category === 'Spelling'))
  const spanish = await check('Quisiéramos pasttel.', { language: 'es' })
  assert.ok(spanish.some(d => d.source === 'pasttel' && d.replacements.some(r => r.text === 'pastel')))
  assert.ok(!spanish.some(d => d.source === 'Quisiéramos'))
})

test('grammar shows word choice, usage, idioms, word boundaries and spacing; style hints only when asked; house style never', async t => {
  const service = writingService(t)
  const check = async (text, extra) => (await service.check(request(text, extra))).blocks[0].diagnostics
  const found = async (text, rule, category, extra) => {
    const diagnostics = await check(text, extra)
    const match = diagnostics.find(d => d.rule === rule)
    assert.ok(match, rule + ' in: ' + text + ' → ' + JSON.stringify(diagnostics.map(d => d.rule)))
    assert.equal(match.category, category)
    assert.equal(text.slice(match.from, match.to), match.source)
  }
  await found('We should of known better.', 'ModalOf', 'Word choice')
  await found('She is taller then her brother.', 'ThenThan', 'Grammar')
  await found('Alot of people came.', 'OpenCompounds', 'Word boundary')
  await found('For all intensive purposes it works.', 'AllIntentsAndPurposes', 'Idiom')
  await found('The new rule is more better than the old one.', 'MoreBetter', 'Grammar')
  await found('We discussed about the plan.', 'Discuss', 'Usage')
  await found('She said hello .Then she left.', 'Spaces', 'Spacing')
  const long = 'The report that the committee wrote after many long meetings in the spring and the summer was so detailed and so carefully argued that nobody who read it could find anything to object to, even though several members had expected to disagree with nearly every recommendation it made.'
  assert.ok(!(await check(long)).some(d => d.category === 'Style'))
  await found(long, 'LongSentences', 'Style', { style: true })
  await found('The dog is very unique.', 'VeryUnique', 'Style', { style: true })
  assert.ok(!(await check('The dog is very unique.', { grammar: false, spelling: false, style: true })).length, 'style hints join grammar checks')
  for (const extra of [{}, { style: true }]) {
    assert.ok(!(await check('I bought apples, pears and plums. Me and him have three cats.', extra)).some(d => ['OxfordComma', 'NoOxfordComma', 'SpelledNumbers', 'AvoidContractions'].includes(d.rule)))
  }
})

test('the main boundary rejects invalid and unbounded requests, and the worker can restart', async t => {
  const service = writingService(t)
  for (const invalid of [null, {}, request('text', { language: '../../etc' }), request('text', { language: 'fr' }), request('x'.repeat(32_001)), request('text', { words: ['two words'] }), request('text', { disabledRules: ['__proto__'] }), request('text', { spelling: 'yes' }), request('text', { style: 'yes' })]) {
    assert.throws(() => service.check(invalid), /Invalid writing check/)
  }
  assert.ok((await service.check(request('I want creem.'))).blocks[0].diagnostics.length)
  service.stop()
  assert.ok((await service.check(request('I want creem.'))).blocks[0].diagnostics.length)
})
