// Run explicitly on a disposable Linux desktop account with the candidate
// installed. Set TINTO_LINUX_KEYRING to the expected backend, or "unavailable"
// for a session with the keyring disabled, locked or its unlock request denied.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopFixture } from './desktop-fixture.mjs'

// Only the provider transport is simulated. The app saves and reopens the
// disposable API key through its ordinary translation settings handlers.
async function translationService(app, key) {
  await app.evaluate((_, key) => {
    globalThis.fetch = async (url, init) => {
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer ' + key) return new Response(null, { status: 401 })
      if (url === 'https://api.openai.com/v1/models/fixture' && init.method === 'GET') return Response.json({ id: 'fixture' })
      if (url === 'https://api.openai.com/v1/responses' && init.method === 'POST') {
        return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ texts: ['Hola'] }) }] }] })
      }
      return new Response(null, { status: 404 })
    }
  }, key)
}

test('the installed editor uses the Linux credential service and keeps local editing available', { timeout: 120_000 }, async t => {
  const expected = process.env.TINTO_LINUX_KEYRING
  assert.equal(process.platform, 'linux')
  assert.ok(process.env.TINTO_PACKAGED_EXECUTABLE, 'Set TINTO_PACKAGED_EXECUTABLE to the installed Tinto executable.')
  assert.ok(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'unavailable'].includes(expected), 'Set TINTO_LINUX_KEYRING to the expected service or unavailable.')
  const fixture = await desktopFixture(t)
  let page = await fixture.open()
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const { backend, available, sandboxDisabled, mockKeychain, appVersion, electronVersion } = await fixture.app.evaluate(async ({ app, safeStorage }) => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    available: await safeStorage.isAsyncEncryptionAvailable(),
    backend: safeStorage.getSelectedStorageBackend(),
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
    mockKeychain: app.commandLine.hasSwitch('use-mock-keychain')
  }))
  t.diagnostic('Tinto ' + appVersion + ', Electron ' + electronVersion + ', backend ' + backend + ', async encryption available = ' + available)
  assert.equal(appVersion, version)
  assert.equal(sandboxDisabled, false)
  assert.equal(mockKeychain, false)

  const name = 'Tinto Keyring Fixture'
  const apiKey = randomUUID()
  let author
  const create = () => page.evaluate(name => window.tinto.createAuthor(name), name)
  if (expected === 'unavailable') {
    const provider = await fixture.app.evaluate(async ({ safeStorage }) => {
      try { return (await safeStorage.encryptStringAsync('Tinto nonsecret probe')).toString('latin1', 0, 3) }
      catch { return 'unavailable' }
    })
    t.diagnostic('Async encryption without the service returned ' + provider)
    assert.ok(['v10', 'unavailable'].includes(provider), 'Expected an unavailable service or the POSIX fallback')
    await assert.rejects(create(), /keyring|encryptStringAsync/i)
    assert.ok(!(await readdir(fixture.profile)).some(file => file.startsWith('author.enc')))
  } else {
    assert.equal(backend, expected)
    assert.equal(available, true)
    author = await create()
    assert.equal(author.name, name)
    assert.match(author.did, /^did:key:z6Mk/)
    const file = join(fixture.profile, 'author.enc')
    const bytes = await readFile(file)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(bytes.includes(Buffer.from(name)), false)
    const tag = bytes.toString('latin1', 0, 3)
    assert.ok(['v11', 'v12'].includes(tag), 'Expected keyring- or portal-protected ciphertext')
    t.diagnostic('author.enc provider tag ' + tag + ', permissions 0600')
    await translationService(fixture.app, apiKey)
    await page.evaluate(key => window.tinto.saveTranslator('openai', key, 'fixture'), apiKey)
    const translatorFile = join(fixture.profile, 'translation.enc')
    assert.equal((await stat(translatorFile)).mode & 0o777, 0o600)
    assert.equal((await readFile(translatorFile)).includes(Buffer.from(apiKey)), false)
  }

  const paragraph = page.locator('.ProseMirror:visible p').first()
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.type('The manuscript still saves locally.')
  await page.keyboard.press('Control+s')
  await fixture.close()
  page = await fixture.open()
  assert.match(await page.locator('.ProseMirror:visible').innerText(), /The manuscript still saves locally\./)
  assert.deepEqual(await page.evaluate(() => window.tinto.author()), author ?? null)

  if (author) {
    await translationService(fixture.app, apiKey)
    assert.deepEqual(await page.evaluate(() => window.tinto.translateTexts(['Hello'], 'en', 'es')), ['Hola'])
    const exported = join(fixture.directory, 'fixture.tintokey')
    const passphrase = randomUUID()
    await fixture.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
    assert.equal(await page.evaluate(value => window.tinto.exportAuthor(value), passphrase), exported)
    const fresh = await desktopFixture(t)
    const freshPage = await fresh.launch()
    await fresh.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, exported)
    assert.deepEqual(await freshPage.evaluate(value => window.tinto.importAuthor(value), passphrase), author)
  }
})
