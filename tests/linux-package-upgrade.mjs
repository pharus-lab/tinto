// Start with the prerelease installed in a disposable desktop account. This
// test keeps the same profile and keyring while the operator performs each
// package operation printed below.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { desktopFixture } from './desktop-fixture.mjs'

function installedVersion() {
  const query = spawnSync('dpkg-query', ['-W', '-f=${db:Status-Status} ${Version}', 'tinto'], { encoding: 'utf8' })
  if (query.error) throw query.error
  if (query.status === 1 || /^config-files /.test(query.stdout)) return null
  assert.equal(query.status, 0)
  return /^installed (.+)$/.exec(query.stdout)?.[1]
}

async function waitForPackage(version, instruction) {
  console.log(instruction)
  const deadline = Date.now() + 15 * 60_000
  while (installedVersion() !== version) {
    if (Date.now() >= deadline) throw Error('Timed out waiting for the package operation.')
    await delay(500)
  }
}

async function contents(page) {
  return page.evaluate(async () => {
    const { project } = await window.tinto.workspace()
    return {
      projectId: project.id, documents: project.documents, author: await window.tinto.author(),
      fonts: await window.tinto.fonts(), preferences: JSON.parse(localStorage.getItem('reading')),
      dictionary: JSON.parse(localStorage.getItem('writing-checks')),
      history: (await window.tinto.versions(project.documents[0].id)).filter(item => item.name)
    }
  })
}

test('installed prerelease data survives upgrade, removal and reinstall', { timeout: 50 * 60_000 }, async t => {
  assert.equal(process.platform, 'linux')
  assert.equal(process.env.TINTO_PACKAGED_EXECUTABLE, '/usr/bin/tinto')
  const expectedBackend = process.env.TINTO_LINUX_KEYRING
  assert.ok(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(expectedBackend))
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const previous = installedVersion()
  assert.ok(previous?.startsWith(version + '~'), 'Install the matching prerelease before starting.')
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  assert.equal(await page.evaluate(() => window.tinto.version), previous.replace('~', '-'))
  assert.equal(await fixture.app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend()), expectedBackend)
  await page.evaluate(() => window.tinto.createAuthor('Tinto Upgrade Fixture'))
  const authorFile = join(fixture.profile, 'author.enc')
  const cipher = await readFile(authorFile)
  assert.ok(['v11', 'v12'].includes(cipher.toString('latin1', 0, 3)))
  assert.equal((await stat(authorFile)).mode & 0o777, 0o600)
  const font = join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')
  await fixture.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, font)
  const added = await page.evaluate(() => window.tinto.addFonts('Tinto'))
  assert.equal(added.added.length, 1)
  await page.locator('.ProseMirror:visible p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('Persist through every package operation.')
  await page.keyboard.press('Control+s')
  await page.evaluate(async font => {
    const { project } = await window.tinto.workspace()
    await window.tinto.nameVersion(project.documents[0].id, 'Before Linux upgrade')
    localStorage.setItem('reading', JSON.stringify({ ...JSON.parse(localStorage.getItem('reading')), appearance: 'dark', checkUpdates: false, font: 'user:' + font }))
    localStorage.setItem('writing-checks', JSON.stringify({ spelling: false, grammar: false, words: { en: ['Tintoword'] }, disabledRules: [] }))
  }, added.added[0])
  await fixture.close()
  page = await fixture.open()
  const baseline = await contents(page)
  assert.match(JSON.stringify(baseline.documents), /Persist through every package operation\./)
  assert.match(baseline.author.did, /^did:key:z6Mk/)
  assert.ok(baseline.history.some(item => item.name === 'Before Linux upgrade'))
  assert.equal(baseline.fonts[0].family, 'Liberation Sans')
  assert.equal(baseline.preferences.font, 'user:' + added.added[0])
  assert.deepEqual(baseline.dictionary.words.en, ['Tintoword'])
  assert.equal(baseline.preferences.appearance, 'dark')
  const storedFont = join(fixture.profile, 'fonts', baseline.fonts[0].faces[0].file)
  const fontBytes = await readFile(font)
  await fixture.close()

  async function verify() {
    const reopened = await fixture.open()
    assert.equal(await reopened.evaluate(() => window.tinto.version), version)
    assert.deepEqual(await contents(reopened), baseline)
    assert.deepEqual(await readFile(storedFont), fontBytes)
    assert.deepEqual(await readFile(authorFile), cipher)
    assert.equal((await stat(authorFile)).mode & 0o777, 0o600)
    await fixture.close()
  }
  await waitForPackage(version, 'Prerelease baseline verified. Upgrade Tinto to ' + version + '.')
  await verify()
  await waitForPackage(null, 'Upgrade verified. Remove the Tinto package.')
  assert.deepEqual(await readFile(authorFile), cipher)
  assert.deepEqual(await readFile(storedFont), fontBytes)
  await waitForPackage(version, 'Removal verified. Reinstall Tinto ' + version + '.')
  await verify()
})
