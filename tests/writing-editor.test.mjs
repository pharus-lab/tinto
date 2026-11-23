import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { writingService } from './writing-fixture.mjs'

const text = (value, marks = []) => ({ type: 'text', text: value, marks })
const block = (id, content, level) => ({ type: level ? 'heading' : 'paragraph', attrs: { id, ...(level ? { level } : {}) }, content })
const doc = (...content) => ({ type: 'doc', content })
const origin = source => ({ type: 'origin', attrs: { source } })
const choice = (id, content) => ({ type: 'choice', attrs: { id, active: id + '-yes', options: [{ id: id + '-no', content: [text('hiddenmispelling')] }, { id: id + '-yes' }] }, content })
const off = { spelling: false, grammar: false, words: {}, disabledRules: [] }

async function fixture(t, handler) {
  const service = handler ? null : writingService(t)
  const bundle = await build({ entryPoints: ['tests/writing-editor-fixture.js'], bundle: true, format: 'esm', platform: 'browser', write: false })
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.exposeBinding('checkWriting', (_source, request) => handler ? handler(request) : service.check(request))
  await page.route('http://localhost/**', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? bundle.outputFiles[0].text : '<main></main><aside></aside><div id="settings"></div><output></output><script type="module" src="/proof.js"></script>' }))
  await page.goto('http://localhost/')
  await page.waitForFunction(() => window.proof)
  return page
}
async function check(page) {
  await page.evaluate(() => proof.check())
  await page.waitForFunction(() => proof.status().status === 'ready')
  return page.evaluate(() => proof.issues())
}

test('individual corrections preserve Unicode, formatting and all origins, with exact undo and no typing evidence', async t => {
  const page = await fixture(t)
  for (const source of ['pasted', 'imported', 'ai']) {
    const manuscript = doc(block('p', [text('😀 Cafe\u0301. I want ', [origin(source)]), text('cr', [{ type: 'strong' }, origin(source)]), text('eem', [{ type: 'em' }, origin(source)]), text('.', [origin(source)])]))
    await page.evaluate(manuscript => proof.setup(manuscript), manuscript)
    const before = await page.evaluate(() => proof.raw())
    const issues = await check(page)
    assert.ok(issues.some(d => d.source === 'creem' && !d.manualReason))
    assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), true)
    const after = await page.evaluate(() => proof.raw())
    assert.equal(after.content[0].content.map(n => n.text).join(''), '😀 Cafe\u0301. I want cream.')
    assert.deepEqual(after.content[0].content.filter(n => n.marks?.some(m => m.type === 'strong')).map(n => n.text), ['cr'])
    assert.deepEqual(after.content[0].content.filter(n => n.marks?.some(m => m.type === 'em')).map(n => n.text), ['eam'])
    assert.ok(after.content[0].content.every(n => n.marks.some(m => m.type === 'origin' && m.attrs.source === source)))
    await page.evaluate(() => proof.undo())
    assert.deepEqual(await page.evaluate(() => proof.raw()), before)
    await page.evaluate(() => proof.redo())
    assert.deepEqual(await page.evaluate(() => proof.raw()), after)
    await page.evaluate(() => proof.flush())
    assert.deepEqual(await page.evaluate(() => proof.samples), [], 'no keystrokes, paste or generation events fabricated')
  }
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('I want cr', [origin('imported')]), text('eem.')])) )
  assert.match((await check(page)).find(d => d.source === 'creem').manualReason, /different origins/)
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), false)
})

test('nested chosen alternatives are checked; cross-boundary corrections and stale source are refused', async t => {
  const page = await fixture(t)
  const manuscript = doc(block('p', [choice('outer', [text('I want '), choice('inner', [text('creem')]), text('.')])]))
  await page.evaluate(manuscript => proof.setup(manuscript), manuscript)
  let issues = await check(page)
  assert.ok(issues.some(d => d.source === 'creem'))
  assert.ok(!issues.some(d => d.source.includes('hidden')))
  const before = await page.evaluate(() => proof.json())
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), true)
  assert.equal(await page.evaluate(() => proof.text()), 'I want cream.')
  const after = await page.evaluate(() => proof.json())
  assert.deepEqual(after.content[0].content[0].attrs.options, before.content[0].content[0].attrs.options)
  assert.deepEqual(after.content[0].content[0].content[1].attrs.options, before.content[0].content[0].content[1].attrs.options)
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('I want cr'), choice('boundary', [text('eem')]), text('.')])) )
  issues = await check(page)
  assert.match(issues.find(d => d.source === 'creem').manualReason, /alternative/)
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), false)
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('I want creem.')]), block('q', [text('I want pasttel.')])) )
  await check(page)
  await page.evaluate(() => { proof.remember(); proof.edit(8, 13, 'cream') })
  assert.equal(await page.evaluate(() => proof.applyOld()), false)
  assert.equal(await page.evaluate(() => proof.status().status), 'edited')
  assert.ok((await page.evaluate(() => proof.issues())).some(d => d.source === 'pasttel'), 'unmodified blocks retain manual results')
})

test('Markdown corrections preserve delimiters and origin; linked sections limit checks and retain manual results', async t => {
  const page = await fixture(t)
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('I want '), text('creem', [{ type: 'strong' }, origin('imported')]), text('.')])) )
  await check(page)
  await page.evaluate(() => proof.markdown(true))
  assert.ok((await page.evaluate(() => proof.issues())).some(d => d.source === 'creem'), 'manual results survive switching view')
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), true)
  assert.equal(await page.evaluate(() => proof.text()), 'I want **cream**.')
  await page.evaluate(() => proof.markdown(false))
  assert.equal(await page.locator('strong [data-origin=imported], [data-origin=imported] strong').textContent(), 'cream')
  await page.evaluate(() => proof.source('**creem** and [creem](https://mispelled.invalid) `mispelled` ![mispelled](photo.png)'))
  const prose = await page.evaluate(() => proof.prose())
  assert.ok(prose[0].includes('creem and creem'))
  assert.ok(!prose[0].includes('mispelled') && !prose[0].includes('https'))
  await check(page)
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), true)
  assert.equal(await page.evaluate(() => proof.text()), '**cream** and [creem](https://mispelled.invalid) `mispelled` ![mispelled](photo.png)')
  await page.evaluate(() => proof.source('I want cr<u>ee</u>m.'))
  assert.deepEqual(await page.evaluate(() => proof.prose()), ['I want creem.'])
  await check(page)
  assert.equal(await page.evaluate(() => proof.apply('creem', 'cream')), true)
  assert.equal(await page.evaluate(() => proof.text()), 'I want cr<u>ea</u>m.')
  const sections = doc(block('one', [text('First section')], 1), block('p', [text('I want creem.')]), block('two', [text('Second section')], 1), block('q', [text('I want pasttel.')]))
  await page.evaluate(manuscript => { proof.setup(manuscript); proof.section('one') }, sections)
  let issues = await check(page)
  assert.ok(issues.some(d => d.source === 'creem'))
  assert.ok(!issues.some(d => d.source === 'pasttel'))
  await page.evaluate(() => proof.section(null))
  assert.equal(await page.evaluate(() => proof.status().manual), false)
  await page.evaluate(() => proof.section('one'))
  assert.equal(await page.evaluate(() => proof.status().manual), true)
  assert.ok((await page.evaluate(() => proof.issues())).some(d => d.source === 'creem'))
})

test('live checks debounce changed blocks, reject late revisions, stop when disabled, and recover from failure', async t => {
  let fail = false, delay = 0
  const page = await fixture(t, async request => {
    await new Promise(resolve => setTimeout(resolve, delay))
    if (fail) throw Error('Engine stopped')
    return { blocks: request.blocks.map(({ id, text }) => ({ id, diagnostics: text.includes('creem') ? [{ from: text.indexOf('creem'), to: text.indexOf('creem') + 5, source: 'creem', rule: 'SpellCheck', category: 'Spelling', message: 'Check spelling.', replacements: [{ from: text.indexOf('creem'), to: text.indexOf('creem') + 5, text: 'cream' }] }] : [] })) }
  })
  await page.evaluate(({ manuscript, off }) => proof.setup(manuscript, { ...off, spelling: true }), { manuscript: doc(block('p', [text('I want creem.')]), block('q', [text('A second paragraph.')])), off })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => proof.requests.length), 0)
  await page.waitForFunction(() => proof.status().status === 'ready')
  assert.equal(await page.evaluate(() => proof.requests[0].blocks.length), 2)
  await page.evaluate(() => { proof.edit(1, 1, 'A'); proof.edit(1, 2, 'B'); proof.edit(1, 2, 'I') })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => proof.requests.length), 1)
  await page.waitForFunction(() => proof.requests.length === 2 && proof.status().status === 'ready')
  assert.equal(await page.evaluate(() => proof.requests[1].blocks.length), 1)
  delay = 600
  await page.evaluate(() => proof.check())
  await page.waitForFunction(() => proof.requests.length === 3)
  await page.evaluate(off => { proof.configure({ language: 'es', preferences: off }); proof.edit(1, 1, 'New ') }, off)
  await page.waitForTimeout(800)
  assert.deepEqual(await page.evaluate(() => proof.issues()), [])
  assert.equal(await page.evaluate(() => proof.requests.length), 3, 'disabled checks do not schedule more work')
  delay = 0; fail = true
  await page.evaluate(() => proof.check())
  await page.waitForFunction(() => proof.status().status === 'error')
  await page.evaluate(() => proof.edit(1, 1, 'Still editable. '))
  assert.match(await page.evaluate(() => proof.text()), /^Still editable/)
  fail = false
  await check(page)
  assert.ok((await page.evaluate(() => proof.issues())).length)
  const long = 'A simple sentence. '.repeat(4000) + '😀 I want creem.'
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('long', [text(long)])))
  assert.ok((await check(page)).some(d => d.from === long.indexOf('creem')))
  const requests = await page.evaluate(() => proof.requests)
  assert.ok(requests.length > 1, 'an oversized paragraph is checked in bounded batches')
  assert.equal(requests.flatMap(request => request.blocks).map(block => block.text).join(''), long)
  assert.ok(requests.every(request => request.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 64_000 && request.blocks.every(block => block.text.length <= 32_000)))
})

test('unsupported languages never reach the checker and resume when changed to a supported language', async t => {
  const page = await fixture(t, async request => ({ blocks: request.blocks.map(({ id }) => ({ id, diagnostics: [] })) }))
  await page.evaluate(({ manuscript, off }) => {
    proof.setup(manuscript, { ...off, spelling: true, grammar: true })
    proof.configure({ language: 'fr' })
  }, { manuscript: doc(block('p', [text('Un ancien document.')])), off })
  await page.waitForTimeout(650)
  assert.equal(await page.evaluate(() => proof.requests.length), 0)
  await page.evaluate(() => proof.check())
  await page.waitForFunction(() => proof.status().error?.code === 'unsupported-language')
  assert.equal(await page.evaluate(() => proof.requests.length), 0)
  await page.evaluate(() => proof.edit(1, 1, 'Encore. '))
  assert.match(await page.evaluate(() => proof.text()), /^Encore/)
  await page.evaluate(() => proof.configure({ language: 'es' }))
  await page.waitForFunction(() => proof.status().status === 'ready')
  assert.equal(await page.evaluate(() => proof.requests.at(-1).language), 'es')
})

test('adding a paragraph invalidates a completed manual check without enabling live checks', async t => {
  const page = await fixture(t, async request => ({ blocks: request.blocks.map(({ id }) => ({ id, diagnostics: [] })) }))
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('A quiet garden.')])))
  await check(page)
  await page.evaluate(() => proof.append('Unchecked new prose.'))
  assert.equal(await page.evaluate(() => proof.status().status), 'edited')
  assert.equal(await page.evaluate(() => proof.status().enabled), false)
  assert.doesNotMatch(await page.locator('aside [role=status]').innerText(), /No issues found/)
})

test('a chosen correction and keyboard focus survive arriving batches and repeated sidebar renders', async t => {
  let release, started
  const secondBatch = new Promise(resolve => { started = resolve })
  const page = await fixture(t, async request => {
    if (request.blocks[0].id === '32') await new Promise(resolve => { release = resolve; started() })
    return { blocks: request.blocks.map(({ id, text }) => ({ id, diagnostics: [{ from: 7, to: 12, source: 'creem', rule: 'SpellCheck', category: 'Spelling', message: 'Check spelling.', replacements: ['cream', 'creek'].map(text => ({ from: 7, to: 12, text })) }] })) }
  })
  t.after(() => release?.())
  await page.evaluate(manuscript => proof.setup(manuscript), doc(...Array.from({ length: 40 }, (_, i) => block('p' + i, [text('I want creem.')]))))
  await page.evaluate(() => proof.check())
  await secondBatch
  const correction = page.getByRole('combobox', { name: 'Proposed correction for creem' }).first()
  await correction.selectOption('1')
  await correction.focus()
  await page.evaluate(() => proof.render())
  assert.equal(await correction.inputValue(), '1')
  release()
  await page.waitForFunction(() => proof.status().status === 'ready')
  assert.equal(await correction.inputValue(), '1')
  assert.equal(await correction.evaluate(el => el === document.activeElement), true)
  await page.getByRole('button', { name: 'Apply', exact: true }).first().click()
  assert.match(await page.evaluate(() => proof.text()), /^I want creek\./)
})

test('repeated manual check actions share the current request and dismissal rejects late results', async t => {
  let release, started, nextStarted
  const pending = new Promise(resolve => { started = resolve })
  const nextPending = new Promise(resolve => { nextStarted = resolve })
  let calls = 0
  const page = await fixture(t, async request => {
    ++calls
    await new Promise(resolve => { release = resolve; calls === 1 ? started() : nextStarted() })
    return { blocks: request.blocks.map(({ id }) => ({ id, diagnostics: [] })) }
  })
  t.after(() => release?.())
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('A quiet garden.')])))
  await page.evaluate(() => proof.check())
  await pending
  await page.evaluate(() => { for (let i = 0; i < 5; i++) proof.check() })
  release()
  await page.waitForFunction(() => proof.status().status === 'ready')
  assert.equal(calls, 1)
  await page.evaluate(() => proof.check())
  await nextPending
  await page.evaluate(() => proof.dismiss())
  release()
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => proof.status().manual), false)
  assert.deepEqual(await page.evaluate(() => proof.issues()), [])
  assert.equal(calls, 2)
})

test('failed preference writes keep the saved toggle and dictionary while explaining the failure', async t => {
  const page = await fixture(t, async request => ({ blocks: request.blocks.map(({ id }) => ({ id, diagnostics: [] })) }))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(manuscript => {
    proof.setup(manuscript, { spelling: false, grammar: false, words: { en: ['Savedword'] }, disabledRules: ['AnA'] }); proof.settings()
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'writing-checks') throw new DOMException('Settings full', 'QuotaExceededError')
      return setItem.call(this, key, value)
    }
  }, doc(block('p', [text('A quiet garden.')])))
  const spelling = page.getByLabel('Check spelling while typing', { exact: true })
  await spelling.click()
  assert.equal(await spelling.isChecked(), false)
  assert.match(await page.locator('#settings').innerText(), /could not be saved/i)
  const input = page.getByRole('textbox', { name: 'Word to add' })
  await input.fill('Tintoish')
  await page.getByRole('button', { name: 'Add word', exact: true }).click()
  assert.equal(await input.inputValue(), 'Tintoish')
  assert.equal(await page.getByRole('button', { name: 'Remove Tintoish', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Remove Savedword', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Remove Savedword', exact: true }).count(), 1)
  await page.getByRole('button', { name: 'Restore An A', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Restore An A', exact: true }).count(), 1)
  assert.deepEqual(errors, [])
})

test('dictionary and grammar controls restore retained results and explain duplicate words', async t => {
  const page = await fixture(t)
  await page.evaluate(manuscript => proof.setup(manuscript), doc(block('p', [text('This is a example. I want creem.')])))
  await check(page)
  const spelling = page.getByRole('region', { name: 'Spelling: creem', exact: true })
  await spelling.getByRole('button', { name: 'Add to personal dictionary', exact: true }).click()
  await spelling.waitFor({ state: 'detached' })
  await page.evaluate(() => proof.settings())
  await page.getByRole('button', { name: 'Remove creem', exact: true }).click()
  await spelling.waitFor()
  assert.equal(await page.evaluate(() => proof.status().status), 'edited')
  const disable = page.getByRole('button', { name: 'Disable this grammar rule', exact: true }).first()
  const rule = await disable.getAttribute('title')
  await disable.click()
  await page.evaluate(() => proof.settings())
  await page.getByRole('button', { name: 'Restore ' + rule.replace(/([a-z])([A-Z])/g, '$1 $2'), exact: true }).click()
  await page.getByRole('button', { name: 'Disable this grammar rule', exact: true }).first().waitFor()
  const word = page.getByRole('textbox', { name: 'Word to add' })
  for (const value of ['Tintoish', 'TINTOISH']) {
    await word.fill(value)
    await page.getByRole('button', { name: 'Add word', exact: true }).click()
  }
  assert.match(await page.locator('#settings').innerText(), /already in your dictionary/)
  assert.equal(await page.getByRole('button', { name: 'Remove Tintoish', exact: true }).count(), 1)
})

test('large-result pagination continues keyboard review and resets for another document', async t => {
  const page = await fixture(t, async request => ({ blocks: request.blocks.map(({ id }) => ({ id, diagnostics: [{ from: 7, to: 12, source: 'creem', rule: 'SpellCheck', category: 'Spelling', message: 'Check spelling.', replacements: [{ from: 7, to: 12, text: 'cream' }] }] })) }))
  const manuscript = doc(...Array.from({ length: 70 }, (_, i) => block('p' + i, [text('I want creem.')])) )
  await page.evaluate(manuscript => proof.setup(manuscript), manuscript)
  await check(page)
  assert.equal(await page.locator('aside .writing-result').count(), 50)
  await page.getByRole('button', { name: 'Show more results', exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('aside .writing-result').count(), 70)
  assert.equal(await page.locator('aside .writing-result').nth(50).locator('.writing-passage').evaluate(el => el === document.activeElement), true)
  await page.evaluate(manuscript => proof.setup(manuscript), manuscript)
  await check(page)
  assert.equal(await page.locator('aside .writing-result').count(), 50)
})
