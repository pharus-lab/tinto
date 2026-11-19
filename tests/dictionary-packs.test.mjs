import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/dictionary-packs.ts'], platform: 'node', format: 'esm', bundle: true, write: false })
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
const { listPacks, installPack } = await import(moduleUrl)

async function profile(t) {
  const path = await mkdtemp(join(tmpdir(), 'tinto-dictionary-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  return path
}

test('a failed verification leaves the dictionary available for a fresh download', async t => {
  const path = await profile(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('incomplete dictionary'))
  await assert.rejects(installPack(path, 'fr'), /failed verification/)
  assert.equal((await listPacks(path)).find(pack => pack.code === 'fr').installed, false)
  assert.deepEqual(await readdir(join(path, 'dictionaries')), [])
})

test('download and read a third dictionary in a fresh offline process', { skip: process.env.TINTO_DICTIONARY_NETWORK_TEST !== '1' }, async t => {
  const path = await profile(t)
  await installPack(path, 'fr')
  assert.match(await readFile(join(path, 'dictionaries', 'fr', 'license'), 'utf8'), /Mozilla Public License/)
  const script = `
    import assert from 'node:assert/strict'
    import nspell from 'nspell'
    const { readPack, listPacks, installPack } = await import(process.argv[1])
    globalThis.fetch = () => { throw Error('offline') }
    const path = process.argv[2]
    assert.ok((await listPacks(path)).find(pack => pack.code === 'fr').installed)
    await installPack(path, 'fr')
    const dictionary = nspell(await readPack(path, 'fr'))
    assert.ok(dictionary.correct('fromage'))
    assert.ok(!dictionary.correct('frommage'))
    assert.ok(dictionary.suggest('frommage').includes('fromage'))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, path], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
