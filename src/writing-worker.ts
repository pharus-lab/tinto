import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WritingEngine } from './writing-engine'
import { validateWritingRequest } from './writing-types'

// The published full binary is inlined. Reject network requests even if a
// future engine version accidentally tries to fetch a remote asset.
const localFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('data:application/wasm;base64,')) return Promise.reject(Error('Writing checks run offline.'))
  return localFetch(input, init)
}

const engine = new WritingEngine(async language => {
  if (language !== 'es') throw Error('Unsupported spelling language.')
  const [aff, dic] = await Promise.all(['aff', 'dic'].map(extension => readFile(join(workerData.assets, 'dictionaries', 'es.' + extension), 'utf8')))
  return { aff, dic }
})
// Serial requests keep the dialect and personal dictionary isolated between
// documents. No manuscript contents or engine statistics are written to disk.
let pending = Promise.resolve()
parentPort!.on('message', ({ id, request }) => {
  pending = pending.then(async () => {
    try { parentPort!.postMessage({ id, result: await engine.check(validateWritingRequest(request)) }) }
    catch {
      // Keep raw engine errors inside the worker.
      parentPort!.postMessage({ id, result: { blocks: [], error: { code: 'unavailable' } } })
    }
  })
})
