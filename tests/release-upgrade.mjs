// Opt-in installer upgrade check. Run against two mounted release applications.
// Both apps use the same disposable profile and manuscripts, never the user's data.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright'

const previousExecutable = process.env.TINTO_PREVIOUS_EXECUTABLE
const currentExecutable = process.env.TINTO_PACKAGED_EXECUTABLE
// The release being upgraded from: 1.0.0 unless TINTO_PREVIOUS_VERSION names another.
const previousVersion = process.env.TINTO_PREVIOUS_VERSION ?? '1.0.0'
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const editor = page => page.locator('.ProseMirror:visible')

test('the v' + previousVersion + ' project and profile survive the release upgrade and writing corrections', { timeout: 120_000 }, async t => {
  assert.ok(previousExecutable && currentExecutable, 'Set TINTO_PREVIOUS_EXECUTABLE and TINTO_PACKAGED_EXECUTABLE to the mounted release executables.')
  const directory = await mkdtemp(join(tmpdir(), 'tinto-release-upgrade-'))
  const profile = join(directory, 'profile')
  const manuscripts = join(directory, 'Manuscripts')
  await mkdir(manuscripts)
  const rendererErrors = []
  let app
  async function close() {
    if (app) await app.close()
    app = undefined
  }
  t.after(async () => {
    await close()
    await rm(directory, { recursive: true, force: true })
  })
  async function launch(executablePath, expectedVersion) {
    app = await electron.launch({ executablePath, env: { ...process.env, TINTO_USER_DATA: profile, TINTO_RELEASES_URL: 'http://127.0.0.1:9/releases/latest', TINTO_EXPERIMENTAL: '0' } })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => rendererErrors.push(error.message))
    await page.waitForURL('tinto://app/index.html')
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion)
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
    return page
  }
  async function snapshot(page) {
    return page.evaluate(async () => {
      const { project } = await window.tinto.workspace()
      const history = {}, drafts = {}, authorship = {}
      for (const doc of project.documents) {
        history[doc.id] = await window.tinto.versions(doc.id)
        if (doc.source) drafts[doc.id] = await window.tinto.reviewDraft(doc.id)
        const { characters, typed, intact } = await window.tinto.authorship(doc.id, null)
        authorship[doc.id] = { characters, typed, intact }
      }
      // A preference a newer release adds with an empty default changes nothing the writer chose.
      const reading = JSON.parse(localStorage.getItem('reading'))
      if (Array.isArray(reading?.hiddenTools) && !reading.hiddenTools.length) delete reading.hiddenTools
      return { project, history, drafts, authorship, reading }
    })
  }

  let page = await launch(previousExecutable, previousVersion)
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, manuscripts)
  await button(page, 'Choose folder').click()
  await button(page, 'Open sample project').click()
  await editor(page).waitFor()
  await button(page.getByRole('region', { name: 'Within this passage' }), 'Edit in manuscript').click()
  await page.keyboard.type('creem')
  await editor(page).locator('p').first().evaluate(node => {
    node.closest('.ProseMirror').focus()
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.type(' Saved before the upgrade.')
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForFunction(async () => JSON.stringify((await window.tinto.workspace()).project).includes('Saved before the upgrade.'))
  const documentId = await page.evaluate(async () => {
    const { path, project } = await window.tinto.workspace()
    const original = project.documents[0]
    await window.tinto.nameVersion(original.id, 'Before the v1.1 upgrade')
    const draft = await window.tinto.createDraft(original.id, null, 'Upgrade revision')
    draft.manuscript.content.find(block => block.type === 'paragraph').content.push({ type: 'text', text: ' A separate draft revision.' })
    window.tinto.save(path, project.id, draft)
    await window.tinto.nameVersion(draft.id, 'Saved draft before upgrade')
    localStorage.setItem('reading', JSON.stringify({ ...JSON.parse(localStorage.getItem('reading')), appearance: 'dark', size: 23, lineNumbers: true, checkUpdates: false, defaultLanguage: 'en' }))
    return original.id
  })
  await close()

  // A restart establishes a persisted v1.0 baseline, including its close-time saves.
  page = await launch(previousExecutable, previousVersion)
  await editor(page).waitFor()
  const baseline = await snapshot(page)
  assert.equal(baseline.project.documents.length, 2)
  assert.match(JSON.stringify(baseline.project), /creem/)
  assert.ok(Object.values(baseline.drafts).some(changes => changes.length > 0))
  assert.ok(baseline.history[documentId].some(item => item.name === 'Before the v1.1 upgrade'))
  assert.ok(baseline.authorship[documentId].typed > 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('writing-checks')), null)
  await close()

  page = await launch(currentExecutable, version)
  await editor(page).waitFor()
  assert.deepEqual(await snapshot(page), baseline, 'documents, hidden/nested choices, draft baselines, named history, authorship and reading preferences survive the upgrade')
  assert.match(await editor(page).innerText(), /Saved before the upgrade\./)
  assert.equal(await page.locator('[data-choice-id="kitchen-food"]').textContent(), 'creem')
  assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), 'dark')
  await button(page, 'Reading and project settings').click()
  const settings = page.getByRole('dialog')
  await settings.getByRole('tab', { name: 'Writing', exact: true }).click()
  assert.equal(await settings.getByLabel('Check spelling while typing', { exact: true }).isChecked(), false)
  assert.equal(await settings.getByLabel('Check English grammar while typing', { exact: true }).isChecked(), false)
  await button(settings, 'Close dialog').click()
  await button(page, 'Check writing').click()
  const checks = page.locator('#writing-checks')
  const cream = checks.getByRole('region', { name: 'Spelling: creem', exact: true })
  await cream.waitFor({ timeout: 60_000 })
  await button(cream, 'Apply').click()
  assert.equal(await page.locator('[data-choice-id="kitchen-food"]').textContent(), 'cream')
  await button(page, 'Undo').click()
  assert.equal(await page.locator('[data-choice-id="kitchen-food"]').textContent(), 'creem')
  await page.keyboard.press('ControlOrMeta+s')
  await close()

  page = await launch(currentExecutable, version)
  await editor(page).waitFor()
  assert.deepEqual(await snapshot(page), baseline, 'the upgraded app saves and reopens the project without altering its content or typing evidence after Apply/Undo')
  assert.deepEqual(rendererErrors, [])
  t.diagnostic('v' + previousVersion + ' → ' + version + ': project, nested/hidden alternatives, draft comparison, named versions, authorship and reading preferences preserved; Harper defaults, Apply/Undo and restart passed.')
})
