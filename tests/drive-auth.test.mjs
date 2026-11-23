import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { get } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const electronStub = {
  name: 'credential-store-test',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'testing' }))
    builder.onLoad({ filter: /.*/, namespace: 'testing' }, () => ({ contents: 'export const safeStorage = globalThis.testVault; export const shell = globalThis.testShell;' }))
  }
}
const bundle = await build({ entryPoints: ['src/drive-auth.ts'], platform: 'node', bundle: true, format: 'esm', write: false, plugins: [electronStub] })
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')

function visit(url) {
  return new Promise((resolve, reject) => {
    get(url, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    }).on('error', reject)
  })
}

test('loopback OAuth checks state and PKCE and sends only the Drive file scope', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-oauth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const vault = new Map()
  globalThis.testVault = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async value => { const key = randomUUID(); vault.set(key, value); return Buffer.from(key) },
    decryptStringAsync: async key => ({ result: vault.get(key.toString()) })
  }
  let challenge
  const requestBody = []
  globalThis.testShell = {
    async openExternal(location) {
      const url = new URL(location)
      assert.equal(url.origin, 'https://accounts.google.com')
      assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file')
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(url.searchParams.get('redirect_uri'))
      assert.equal(callback.hostname, '127.0.0.1')
      callback.search = new URLSearchParams({ state: 'wrong-state', code: 'invalid' })
      assert.equal(await visit(callback), 400)
      callback.searchParams.set('state', url.searchParams.get('state'))
      callback.searchParams.set('code', 'test-grant')
      assert.equal(await visit(callback), 200)
    }
  }
  t.after(() => { delete globalThis.testVault; delete globalThis.testShell })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requestBody.push(options.body)
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response()
    assert.equal(url, 'https://oauth2.googleapis.com/token')
    if (options.body.get('grant_type') === 'authorization_code') {
      assert.equal(options.body.get('code'), 'test-grant')
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), challenge)
      return Response.json({ access_token: 'access-fixture', refresh_token: 'offline-fixture', expires_in: 3600 })
    }
    assert.equal(options.body.get('refresh_token'), 'offline-fixture')
    return Response.json({ access_token: 'refreshed-fixture', expires_in: 3600 })
  })
  const client = join(dir, 'desktop.json')
  await writeFile(client, JSON.stringify({ installed: { client_id: 'desktop-fixture', client_secret: 'secret-fixture' } }))
  const { DriveAuth } = await import(moduleUrl)
  const auth = new DriveAuth(dir)
  await auth.connect(client)
  assert.equal(auth.configured, true)
  assert.equal(auth.connected, true)
  assert.equal(await auth.token(), 'access-fixture')
  assert.ok(!(await readFile(join(dir, 'drive-token.enc'), 'utf8')).includes('offline-fixture'))
  const reopened = new DriveAuth(dir)
  assert.equal(await reopened.token(), 'refreshed-fixture')
  await reopened.disconnect()
  assert.equal(reopened.connected, false)
  assert.equal(requestBody.at(-1).get('token'), 'offline-fixture')
})

test('Linux refuses fallback ciphertext even when Electron selected a desktop keyring', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tinto-keyring-fallback-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fallback = Buffer.from('v10' + 'simulated ciphertext')
  globalThis.testVault = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async () => fallback,
    decryptStringAsync: () => assert.fail('Tinto should reject the fallback before decryption')
  }
  t.after(() => { delete globalThis.testVault })
  const { DriveAuth } = await import(moduleUrl + '#fallback')
  const auth = new DriveAuth(dir)
  const client = join(dir, 'client.json')
  const stored = join(dir, 'drive-client.enc')
  await writeFile(client, JSON.stringify({ installed: { client_id: 'fixture' } }))
  await assert.rejects(auth.connect(client), /Unlock your system keychain or Linux keyring/)
  assert.equal(auth.configured, false)
  await writeFile(stored, 'previous credential')
  await assert.rejects(auth.connect(client), /Unlock your system keychain or Linux keyring/)
  assert.equal(await readFile(stored, 'utf8'), 'previous credential')
  await writeFile(stored, fallback)
  await assert.rejects(auth.connect(), /without Linux keyring protection/)
  assert.deepEqual(await readFile(stored), fallback)
})
