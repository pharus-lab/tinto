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
  assert.ok(!diagnostics.some(d => d.rule === 'VeryUnique' || d.category === 'WordChoice'))
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

test('the main boundary rejects invalid and unbounded requests, and the worker can restart', async t => {
  const service = writingService(t)
  for (const invalid of [null, {}, request('text', { language: '../../etc' }), request('text', { language: 'fr' }), request('x'.repeat(32_001)), request('text', { words: ['two words'] }), request('text', { disabledRules: ['__proto__'] }), request('text', { spelling: 'yes' })]) {
    assert.throws(() => service.check(invalid), /Invalid writing check/)
  }
  assert.ok((await service.check(request('I want creem.'))).blocks[0].diagnostics.length)
  service.stop()
  assert.ok((await service.check(request('I want creem.'))).blocks[0].diagnostics.length)
})
