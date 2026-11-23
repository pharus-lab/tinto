import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const editor = page => page.locator('.ProseMirror:visible')
const spelling = page => editor(page).locator('.tinto-misspelling')
const grammar = page => editor(page).locator('.tinto-grammar')
async function settings(page) {
  await button(page, 'Reading and project settings').click()
  const modal = page.getByRole('dialog')
  await modal.getByRole('tab', { name: 'Writing', exact: true }).click()
  return modal
}
async function seed(page, lines) {
  await page.evaluate(async lines => {
    const { path, project } = await window.tinto.workspace()
    const doc = project.documents[0]
    doc.manuscript = { type: 'doc', content: lines.map((text, i) => ({ type: 'paragraph', attrs: { id: 'writing-' + i }, content: [{ type: 'text', text, marks: [{ type: 'origin', attrs: { source: 'imported' } }] }] })) }
    window.tinto.save(path, project.id, doc)
  }, lines)
  await page.reload()
  await editor(page).waitFor()
}
async function manual(page) {
  await button(page, 'Check writing').click()
  await page.locator('#writing-checks [role=status]').filter({ hasText: /possible issue|No issues found/ }).waitFor({ timeout: 60_000 })
  return page.locator('#writing-checks')
}
async function screenshot(page, name) {
  if (!process.env.TINTO_WRITING_QA) return
  await mkdir(process.env.TINTO_WRITING_QA, { recursive: true })
  await page.screenshot({ path: join(process.env.TINTO_WRITING_QA, name + '.png') })
}

test('manual writing checks default off, support individual actions, and keep dictionary and rules across projects and restarts', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  await seed(page, ['This is a example. She go home. I want creem.', 'I want pasttel.'])
  const before = await page.evaluate(async () => {
    const doc = (await window.tinto.workspace()).project.documents[0]
    return window.tinto.authorship(doc.id, null)
  })
  let modal = await settings(page)
  assert.equal(await modal.getByLabel('Check spelling while typing', { exact: true }).isChecked(), false)
  assert.equal(await modal.getByLabel('Check English grammar while typing', { exact: true }).isChecked(), false)
  assert.equal(await modal.getByLabel('Include style hints (wordiness, long sentences)', { exact: true }).isChecked(), false)
  assert.equal(await modal.getByLabel('Writing coach (AI) in Check writing', { exact: true }).isChecked(), false)
  await screenshot(page, 'settings-light')
  await button(modal, 'Close dialog').click()
  assert.equal(await spelling(page).count(), 0)
  assert.equal(await grammar(page).count(), 0)
  let checks = await manual(page)
  assert.match(await checks.innerText(), /English spelling and grammar · chosen wording only/)
  await screenshot(page, 'checks-light')
  const cream = checks.getByRole('region', { name: 'Spelling: creem', exact: true })
  await button(cream, 'Apply').click()
  assert.match(await editor(page).innerText(), /cream/)
  assert.equal(await editor(page).locator('[data-origin=imported]').first().textContent(), 'This is a example. She go home. I want cream.')
  await button(page, 'Undo').click()
  assert.match(await editor(page).innerText(), /creem/)
  checks = await manual(page)
  await button(cream, 'Add to personal dictionary').click()
  await cream.waitFor({ state: 'detached' })
  const disable = checks.getByRole('button', { name: 'Disable this grammar rule', exact: true }).first()
  const rule = await disable.getAttribute('title')
  await disable.click()
  const pasttel = checks.getByRole('region', { name: 'Spelling: pasttel', exact: true })
  await button(pasttel, 'Ignore').click()
  await pasttel.waitFor({ state: 'detached' })
  await button(checks, 'Check again').click()
  await checks.getByRole('status').filter({ hasText: /possible issue/ }).waitFor()
  assert.equal(await pasttel.count(), 0, 'Ignore persists while the passage is unchanged')
  await page.getByRole('tab', { name: 'Alternatives', exact: true }).click()
  assert.equal(await page.locator('#choices').isVisible(), true)
  await page.getByRole('tab', { name: 'Writing checks', exact: true }).click()
  await button(checks, 'Dismiss results').click()
  assert.equal(await spelling(page).count(), 0)
  assert.equal(await grammar(page).count(), 0)
  const after = await page.evaluate(async () => {
    const doc = (await window.tinto.workspace()).project.documents[0]
    return window.tinto.authorship(doc.id, null)
  })
  assert.equal(after.typed, before.typed)
  assert.deepEqual(after.characters, before.characters)
  assert.equal(after.intact, true)
  await fixture.close()
  page = await fixture.open()
  modal = await settings(page)
  await modal.getByRole('button', { name: 'Remove creem', exact: true }).waitFor()
  const restore = modal.getByRole('button', { name: 'Restore ' + rule.replace(/([a-z])([A-Z])/g, '$1 $2'), exact: true })
  await restore.waitFor()
  await restore.click()
  await modal.getByLabel('Word to add', { exact: true }).fill('Tintoish')
  await button(modal, 'Add word').click()
  await modal.getByRole('button', { name: 'Remove Tintoish', exact: true }).waitFor()
  await screenshot(page, 'dictionary-light')
  await button(modal, 'Close dialog').click()
  await fixture.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, join(fixture.folder, 'Second project.tinto'))
  await button(page, 'Home').click()
  await button(page, 'New project').click()
  await page.getByText('No documents yet.', { exact: true }).waitFor()
  await button(page, 'New document').click()
  await page.getByLabel('Document title').fill('Dictionary test')
  await button(page, 'Create document').click()
  await editor(page).fill('I want creem. Tintoish is a word. This is a example.')
  await page.getByLabel('Document spelling language', { exact: true }).selectOption('en-GB')
  checks = await manual(page)
  assert.equal(await checks.getByRole('region', { name: 'Spelling: creem', exact: true }).count(), 0)
  assert.equal(await checks.getByRole('region', { name: 'Spelling: Tintoish', exact: true }).count(), 0)
  assert.ok(await checks.getByRole('button', { name: 'Disable this grammar rule', exact: true }).count(), 'restored grammar rule runs in another project')
  modal = await settings(page)
  await button(modal, 'Remove creem').click()
  await button(modal, 'Close dialog').click()
  checks = await manual(page)
  await checks.getByRole('region', { name: 'Spelling: creem', exact: true }).waitFor()
})

test('live switches are independent, update every open editor, and persist; sidebar works in dark and narrow windows', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  await seed(page, ['She go home. I want creem.'])
  await button(page, 'Home').click()
  await button(page, 'New document').click()
  await page.getByLabel('Document title').fill('Second document')
  await button(page, 'Create document').click()
  await editor(page).fill('She go home. I want creem.')
  let modal = await settings(page)
  await modal.getByLabel('Check spelling while typing', { exact: true }).check()
  await button(modal, 'Close dialog').click()
  await spelling(page).first().waitFor()
  assert.equal(await grammar(page).count(), 0)
  await page.getByRole('tab', { name: 'Writing checks', exact: true }).click()
  assert.match(await page.locator('#writing-checks').innerText(), /English spelling only · chosen wording only/)
  await button(page.locator('#document-tabs'), 'The long way home').click()
  await spelling(page).first().waitFor()
  assert.equal(await grammar(page).count(), 0)
  modal = await settings(page)
  await modal.getByLabel('Check spelling while typing', { exact: true }).uncheck()
  await modal.getByLabel('Check English grammar while typing', { exact: true }).check()
  await modal.getByRole('tab', { name: 'Appearance', exact: true }).click()
  await modal.getByRole('combobox', { name: /^Appearance/ }).selectOption('dark')
  await modal.getByRole('tab', { name: 'Writing', exact: true }).click()
  await screenshot(page, 'settings-dark')
  await button(modal, 'Close dialog').click()
  await grammar(page).first().waitFor()
  assert.equal(await spelling(page).count(), 0)
  await page.getByRole('tab', { name: 'Writing checks', exact: true }).click()
  assert.match(await page.locator('#writing-checks').innerText(), /English grammar only · chosen wording only/)
  await button(page.locator('#document-tabs'), 'Second document').click()
  await grammar(page).first().waitFor()
  assert.equal(await spelling(page).count(), 0)
  await fixture.close()
  page = await fixture.open()
  await grammar(page).first().waitFor()
  assert.equal(await spelling(page).count(), 0)
  await manual(page)
  await screenshot(page, 'checks-dark')
  await (await fixture.app.browserWindow(page)).evaluate(win => win.setSize(740, 700))
  await screenshot(page, 'checks-narrow-dark')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('#panel').evaluate(el => el.scrollWidth > el.clientWidth), false)
  // Shift+F10 offers the same spelling suggestions as right-click, with keyboard focus.
  await spelling(page).first().evaluate(el => {
    el.closest('.ProseMirror').focus(); getSelection().collapse(el.firstChild, 2)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Writing suggestions' })
  await menu.waitFor()
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Add to personal dictionary')
  await page.keyboard.press('Escape')
  assert.equal(await menu.count(), 0)
  modal = await settings(page)
  await screenshot(page, 'settings-narrow-dark')
  await modal.getByLabel('Word to add', { exact: true }).scrollIntoViewIfNeeded()
  await screenshot(page, 'dictionary-narrow-dark')
})

test('legacy French documents stay editable without downloads or checks, and new defaults use English', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  await seed(page, ['Je veux du fromage.'])
  await page.evaluate(async () => {
    const { path, project } = await window.tinto.workspace(), doc = project.documents[0]
    doc.language = 'fr'; window.tinto.save(path, project.id, doc)
    localStorage.setItem('reading', JSON.stringify({ ...JSON.parse(localStorage.getItem('reading')), defaultLanguage: 'fr', checkUpdates: false }))
    localStorage.setItem('writing-checks', JSON.stringify({ spelling: true, grammar: true, words: { fr: ['fromage'] }, disabledRules: [] }))
  })
  await fixture.app.evaluate(() => {
    globalThis.dictionaryRequests = 0
    globalThis.fetch = async () => { globalThis.dictionaryRequests++; throw Error('Offline test') }
  })
  await page.reload()
  assert.equal(await page.locator('#language').inputValue(), 'fr')
  assert.equal(await page.locator('#language option:checked').innerText(), 'French (checks unavailable)')
  assert.equal(await page.locator('#language option:checked').isDisabled(), true)
  await page.locator('#check-writing').click()
  const checks = page.locator('#writing-checks')
  await checks.getByRole('status').filter({ hasText: 'Writing checks support English, English (UK), and Spanish (Mexico).' }).waitFor()
  assert.equal(await button(checks, 'Try again').count(), 0)
  assert.equal(await button(checks, 'Check writing').isDisabled(), true)
  assert.equal(await page.locator('.tinto-misspelling, .tinto-grammar').count(), 0)
  const modal = await settings(page)
  assert.equal(await modal.getByLabel('Default spelling language').inputValue(), 'en')
  assert.deepEqual(await modal.locator('[name=default-language] option').evaluateAll(options => options.map(o => o.value)), ['en', 'en-GB', 'es'])
  assert.deepEqual(await modal.getByLabel('Dictionary language').locator('option').evaluateAll(options => options.map(o => o.value)), ['en', 'es'])
  assert.equal(await button(modal, 'Download dictionary').count(), 0)
  assert.deepEqual(await page.evaluate(() => ['listPacks', 'readPack', 'installPack'].map(method => typeof window.tinto[method])), ['undefined', 'undefined', 'undefined'])
  await modal.getByLabel('Word to add', { exact: true }).fill('Tinto')
  await button(modal, 'Add word').click()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('writing-checks')).words.fr), ['fromage'])
  await button(modal, 'Close dialog').click()
  await editor(page).press('End')
  await page.keyboard.type(' Toujours modifiable.')
  await page.keyboard.press('ControlOrMeta+s')
  await page.reload()
  assert.match(await editor(page).innerText(), /Toujours modifiable/)
  assert.equal(await page.locator('#language').inputValue(), 'fr')
  assert.equal(await fixture.app.evaluate(() => globalThis.dictionaryRequests), 0)
})

test('200% zoom keeps actions distinct and writing checks reachable by keyboard', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  await seed(page, ['She go home. I want creem.'])
  const window = await fixture.app.browserWindow(page)
  for (const [width, height] of [[1240, 840], [740, 700], [740, 520]]) {
    await window.evaluate((win, [width, height]) => { win.setSize(width, height); win.webContents.setZoomFactor(2) }, [width, height])
    await manual(page)
    const layout = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.location button')].filter(el => el.checkVisibility()).map(el => ({ name: el.textContent, rect: el.getBoundingClientRect() }))
      const overlaps = buttons.flatMap((a, i) => buttons.slice(i + 1).flatMap(b => Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1 ? [[a.name, b.name]] : []))
      const clipped = [...document.querySelectorAll('.location button, footer > span:not(.tool-fill), #language-label, #panel-tabs button')].filter(el => el.checkVisibility()).filter(el => {
        const rect = el.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1
      }).map(el => el.id || el.textContent)
      return { overflow: document.documentElement.scrollWidth > innerWidth, overlaps, clipped }
    })
    assert.deepEqual(layout, { overflow: false, overlaps: [], clipped: [] }, width + ' × ' + height)
    await page.getByRole('tab', { name: 'Writing checks', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.getByRole('tab', { name: 'Alternatives', exact: true }).getAttribute('aria-selected'), 'true')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('tab', { name: 'Writing checks', exact: true }).getAttribute('aria-selected'), 'true')
    await button(page, 'Close writing checks').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#panel').isVisible(), false)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'check-writing')
    await editor(page).press('End')
    await page.keyboard.type(' Still editable.')
    assert.match(await editor(page).innerText(), /Still editable/)
  }
})

test('a long manuscript checks offline while the renderer remains responsive', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  await fixture.app.evaluate(({ session }) => { session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })) })
  await seed(page, Array.from({ length: 900 }, (_, i) => ('The old house was quiet. The garden was full of flowers. '.repeat(8)) + (i % 100 === 0 ? 'I want creem.' : '')))
  await page.evaluate(() => {
    window.frameGaps = []; let previous = performance.now()
    window.frameTimer = setInterval(() => { const now = performance.now(); frameGaps.push(now - previous); previous = now }, 20)
  })
  const start = Date.now()
  const checks = await manual(page)
  const gaps = await page.evaluate(() => { clearInterval(frameTimer); return frameGaps })
  assert.ok(gaps.length > 10)
  assert.ok(Math.max(...gaps) < 1000, 'renderer stays responsive; worst scheduling gap ' + Math.max(...gaps))
  assert.equal(await checks.getByRole('region', { name: 'Spelling: creem', exact: true }).count(), 9)
  t.diagnostic('Checked roughly 80,000 words in ' + (Date.now() - start) + ' ms; worst renderer scheduling gap ' + Math.round(Math.max(...gaps)) + ' ms.')
})

test('the writing coach starts off, needs an AI key, and only suggests: no Apply, the text never changes', async t => {
  const fixture = await desktopFixture(t)
  const page = await fixture.open()
  const first = 'I went to the store, I bought bread. The report it was written badly.'
  await seed(page, [first, 'This paragraph is fine.'])
  let checks = await manual(page)
  const toggle = checks.getByRole('checkbox', { name: 'Writing coach (AI)', exact: true })
  assert.equal(await toggle.isChecked(), false)
  assert.equal(await toggle.isDisabled(), true, 'no AI key yet')
  await checks.getByText('Add an AI key in Settings → Writing → AI service.').waitFor()

  // A simulated AI service: the key's status, and a coach that quotes the text it was sent.
  await fixture.app.evaluate(({ ipcMain }) => {
    globalThis.coachRequests = []
    globalThis.coachFails = false
    ipcMain.removeHandler('translator:status')
    ipcMain.handle('translator:status', () => ({ provider: 'openai', name: 'OpenAI', model: 'gpt-6.2-astra' }))
    ipcMain.removeHandler('coach:review')
    ipcMain.handle('coach:review', (_event, request) => {
      globalThis.coachRequests.push(request)
      if (globalThis.coachFails) throw Error('OpenAI is limiting requests for this key. Wait a minute and check again.')
      const block = request.blocks[0]
      const at = (quote, kind, title, suggestion) => ({ block: block.id, quote, kind, title, explanation: 'Explained ' + title + '.', suggestion, from: block.text.indexOf(quote), to: block.text.indexOf(quote) + quote.length })
      return { provider: 'OpenAI', model: 'gpt-6.2-astra', dropped: 1, notes: [
        at('I went to the store, I bought bread.', 'punctuation', 'Comma splice', 'Use a period. For example: "I went to the store. I bought bread."'),
        at('The report it was written badly.', 'syntax', 'Repeated subject', 'Remove "it".')
      ] }
    })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('tinto-ai-service')))
  await checks.getByText('Add an AI key in Settings → Writing → AI service.').waitFor({ state: 'detached' })
  assert.equal(await toggle.isDisabled(), false)
  await manual(page)
  assert.equal(await fixture.app.evaluate(() => globalThis.coachRequests.length), 0, 'off: nothing is sent')

  await toggle.check()
  checks = await manual(page)
  const coach = checks.getByRole('region', { name: 'Writing coach', exact: true })
  await coach.getByRole('status').filter({ hasText: '2 suggestions · gpt-6.2-astra' }).waitFor()
  const [request] = await fixture.app.evaluate(() => globalThis.coachRequests)
  assert.deepEqual(request, { language: 'en', blocks: [{ id: 'p1', text: first }, { id: 'p2', text: 'This paragraph is fine.' }] })
  await coach.getByText('1 left out: not quoted exactly from your text.').waitFor()
  // Local results come first, the coach below them.
  assert.equal(await checks.evaluate(host => { const local = host.querySelector('.writing-results'), coach = host.querySelector('.writing-advanced'); return !!(local.compareDocumentPosition(coach) & Node.DOCUMENT_POSITION_FOLLOWING) }), true)
  const splice = coach.getByRole('region', { name: 'Punctuation: I went to the store, I bought bread.', exact: true })
  await splice.getByText('Punctuation · Comma splice').waitFor()
  await splice.getByText('Explained Comma splice.').waitFor()
  assert.match(await splice.innerText(), /Suggestion: Use a period\. For example: "I went to the store\. I bought bread\."/)
  assert.equal(await splice.getByRole('button', { name: 'Apply' }).count(), 0)
  assert.equal(await splice.getByRole('combobox').count(), 0)
  assert.equal(await editor(page).locator('.tinto-coach').count(), 2)
  await screenshot(page, 'coach-light')
  await button(splice, 'I went to the store, I bought bread.').click()
  assert.equal(await page.evaluate(() => getSelection().toString()), 'I went to the store, I bought bread.')

  // The context menu offers the explanation, the suggestion, Mark as solved and Dismiss.
  const subject = coach.getByRole('region', { name: 'Sentence structure: The report it was written badly.', exact: true })
  await button(subject, 'The report it was written badly.').click()
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ProseMirror')), true, 'the passage is selected in the manuscript, ready to edit')
  await editor(page).locator('.tinto-coach').nth(1).evaluate(el => {
    el.closest('.ProseMirror').focus(); getSelection().collapse(el.firstChild, 4)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Writing coach' })
  await menu.getByText('Sentence structure · Repeated subject').waitFor()
  await menu.getByText('Suggestion: Remove "it".').waitFor()
  assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['Mark as solved', 'Dismiss'])
  await page.keyboard.press('Escape')

  await button(splice, 'Dismiss').click()
  await splice.waitFor({ state: 'detached' })
  assert.equal(await editor(page).locator('p').first().innerText(), first, 'the coach never changes the text')
  await coach.getByRole('status').filter({ hasText: '1 suggestion · gpt-6.2-astra' }).waitFor()

  // Notes stay while you edit; the sidebar says the review is older than the text.
  await editor(page).locator('p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Then I left.')
  await coach.getByText('Edited since the review. Check again to review your changes.').waitFor()
  assert.equal(await editor(page).locator('.tinto-coach').count(), 1)
  await subject.waitFor()

  // A failing service leaves Harper's results in place.
  await fixture.app.evaluate(() => { globalThis.coachFails = true })
  await button(checks, 'Check again').click()
  await coach.getByRole('status').filter({ hasText: 'The writing coach could not review this passage. OpenAI is limiting requests for this key. Wait a minute and check again.' }).waitFor()
  await checks.locator('.settings-note[role=status]').first().filter({ hasText: /possible issue|No issues found/ }).waitFor()

  await toggle.uncheck()
  await coach.getByRole('status').waitFor({ state: 'detached' })
  assert.equal(await page.getByLabel('Document spelling language', { exact: true }).locator('option[value=es]').innerText(), 'Spanish (Mexico)')
})

// A simulated AI service whose coach quotes the text it was sent. A passage the
// writer marked solved but still reads badly comes back with repeat.
async function coachService(fixture) {
  await fixture.app.evaluate(({ ipcMain }) => {
    globalThis.coachRequests = []
    ipcMain.removeHandler('translator:status')
    ipcMain.handle('translator:status', () => ({ provider: 'openai', name: 'OpenAI', model: 'gpt-6.2-astra' }))
    ipcMain.removeHandler('coach:review')
    ipcMain.handle('coach:review', (_event, request) => {
      globalThis.coachRequests.push(request)
      const notes = []
      const at = (quote, kind, title, repeat = false) => {
        for (const block of request.blocks) {
          const from = block.text.indexOf(quote)
          if (from >= 0) notes.push({ block: block.id, quote, kind, title, explanation: 'Explained ' + title + '.', suggestion: 'Fix ' + title + '.', repeat, from, to: from + quote.length })
        }
      }
      at('I went to the store, I bought bread.', 'punctuation', 'Comma splice')
      at('The report it was written badly.', 'syntax', 'Repeated subject')
      at('Their going home now.', 'grammar', 'Their or they’re')
      if (request.resolved?.some(item => item.outcome === 'solved')) at('The report was written so badly.', 'syntax', 'Still unclear', true)
      return { provider: 'OpenAI', model: 'gpt-6.2-astra', dropped: 0, notes }
    })
  })
}
async function selectText(page, text) {
  assert.ok(await page.evaluate(text => {
    const root = [...document.querySelectorAll('.ProseMirror')].find(el => el.offsetParent)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const at = walker.currentNode.data.indexOf(text)
      if (at < 0) continue
      root.focus()
      const range = document.createRange()
      range.setStart(walker.currentNode, at); range.setEnd(walker.currentNode, at + text.length)
      getSelection().removeAllRanges(); getSelection().addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, text), 'found ' + text)
}

test('coach notes follow edits, can be solved or dismissed, survive Markdown and a restart, and the next review checks them', async t => {
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  await seed(page, ['I went to the store, I bought bread. The report it was written badly.', 'Their going home now.'])
  await coachService(fixture)
  let checks = await manual(page)
  await page.evaluate(() => window.dispatchEvent(new Event('tinto-ai-service')))
  const toggle = checks.getByRole('checkbox', { name: 'Writing coach (AI)', exact: true })
  await toggle.check()
  checks = await manual(page)
  const coach = checks.getByRole('region', { name: 'Writing coach', exact: true })
  await coach.getByRole('status').filter({ hasText: '3 suggestions · gpt-6.2-astra' }).waitFor()
  const note = name => coach.getByRole('region', { name, exact: true })
  const splice = note('Punctuation: I went to the store, I bought bread.')
  const subject = note('Sentence structure: The report it was written badly.')
  const their = note('Grammar: Their going home now.')

  // Typing in another paragraph keeps every note in place.
  await editor(page).locator('p').nth(1).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Soon.')
  await coach.getByText('Edited since the review. Check again to review your changes.').waitFor()
  assert.equal(await editor(page).locator('.tinto-coach:not(.tinto-coach-edited)').count() >= 3, true)
  // Revising the passage itself keeps its note, labeled Edited, on the new text.
  await selectText(page, 'it ')
  await page.keyboard.press('Backspace')
  await selectText(page, 'written badly')
  await page.keyboard.type('written so badly')
  await subject.getByText('Edited', { exact: true }).waitFor()
  assert.equal((await editor(page).locator('.tinto-coach-edited').allInnerTexts()).join(''), 'The report was written so badly.', 'the underline follows the revised passage')
  assert.equal(await splice.getByText('Edited', { exact: true }).count(), 0)

  // Dismiss results clears the local results only.
  await button(checks, 'Dismiss results').click()
  await splice.waitFor()
  await button(subject, 'Mark as solved').click()
  await subject.waitFor({ state: 'detached' })
  await coach.getByText('1 solved note will be checked in the next review.').waitFor()
  await button(their, 'Dismiss').click()
  await their.waitFor({ state: 'detached' })
  assert.equal(await editor(page).locator('.tinto-coach').count(), 1)

  // Markdown and back: the note finds its passage again.
  await button(page, 'Markdown').click()
  await button(page, 'Markdown').click()
  await editor(page).locator('.tinto-coach').first().waitFor()
  assert.equal(await editor(page).locator('.tinto-coach').first().innerText(), 'I went to the store, I bought bread.')

  // After a restart the notes and the solved list come back.
  await page.waitForTimeout(600)
  await fixture.close()
  page = await fixture.open()
  checks = page.locator('#writing-checks')
  await page.waitForTimeout(300)
  if (!await checks.isVisible()) {
    if (!await page.getByRole('tab', { name: 'Writing checks', exact: true }).isVisible()) await button(page, 'Alternatives').click()
    await page.getByRole('tab', { name: 'Writing checks', exact: true }).click()
  }
  await checks.getByRole('region', { name: 'Punctuation: I went to the store, I bought bread.', exact: true }).waitFor()
  await checks.getByText('1 solved note will be checked in the next review.').waitFor()
  assert.equal(await editor(page).locator('.tinto-coach').count(), 1)

  // The next review receives what was solved and dismissed, as the passages read now.
  await coachService(fixture)
  await page.evaluate(() => window.dispatchEvent(new Event('tinto-ai-service')))
  await button(checks, 'Check writing').click()
  const again = checks.getByRole('region', { name: 'Writing coach', exact: true })
  await again.getByRole('status').filter({ hasText: /suggestions · gpt-6\.2-astra/ }).waitFor({ timeout: 20_000 })
  const [request] = await fixture.app.evaluate(() => globalThis.coachRequests)
  assert.deepEqual(request.resolved.map(({ outcome, title, now }) => [outcome, title, now]), [
    ['solved', 'Repeated subject', 'The report was written so badly.'],
    ['dismissed', 'Their or they’re', 'Their going home now.']
  ])
  await again.getByRole('region', { name: 'Sentence structure: The report was written so badly.', exact: true }).getByText('Still there', { exact: true }).waitFor()
  assert.equal(await editor(page).locator('p').first().innerText(), 'I went to the store, I bought bread. The report was written so badly.', 'the coach never changes the text')
})

test('AI service estimates what Translate and the writing coach have cost, and the estimate can be reset', async t => {
  const fixture = await desktopFixture(t)
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(fixture.profile, { recursive: true })
  const task = (cost, input, output, extra = {}) => ({ cost, input, output, requests: 3, unpriced: 0, unpricedModels: [], ...extra })
  await writeFile(join(fixture.profile, 'ai-usage.json'), JSON.stringify({ since: '2026-11-23T12:00:00.000Z', translate: task(0.0612, 9000, 3000), coach: task(0.0123, 2000, 1000, { unpriced: 400, unpricedModels: ['my-model'] }) }))
  const page = await fixture.open()
  const modal = await settings(page)
  const usage = modal.locator('.ai-usage')
  await usage.getByText('≈ $0.07').waitFor()
  assert.match(await usage.innerText(), /Estimated spend since Nov 23, 2026/)
  await usage.getByText('Translate · $0.06 · 12,000 tokens').waitFor()
  await usage.getByText('Writing coach · $0.01 · 3,000 tokens').waitFor()
  await usage.getByText('400 tokens with my-model have no known price.').waitFor()
  assert.equal(await usage.getByRole('img').getAttribute('aria-label'), 'Translate $0.06, writing coach $0.01')
  const widths = await usage.locator('.ai-usage-part').evaluateAll(parts => parts.map(part => part.getBoundingClientRect().width))
  assert.ok(widths[0] > widths[1] * 3, 'the bar is split by cost')
  await usage.getByRole('button', { name: 'Reset the estimated spend' }).click()
  await usage.getByText('≈ $0.00').waitFor()
})
