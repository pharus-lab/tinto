import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/ai-usage.ts'], platform: 'node', format: 'esm', bundle: true, write: false })
const { estimate, priceOf, addUsage, emptyUsage, UsageLog, PRICES } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' ≈ ' + expected)

test('each request is priced from its tokens, with cached input at its own rate and the service\'s own cost when it reports one', () => {
  // gpt-6.2-astra: $8 input, $0.40 cached, $40 output per million tokens.
  close(estimate({ model: 'gpt-6.2-astra', input: 1_000_000, cached: 0, output: 0 }), 8)
  close(estimate({ model: 'gpt-6.2-astra', input: 10_000, cached: 4_000, output: 2_000 }), (6_000 * 8 + 4_000 * 0.4 + 2_000 * 40) / 1e6)
  close(estimate({ model: 'claude-opus-5-5', input: 3_000, cached: 0, output: 1_000 }), (3_000 * 4 + 1_000 * 20) / 1e6)
  close(estimate({ model: 'gpt-6-luna', input: 1_000_000, cached: 0, output: 1_000_000 }), 0.6)
  // OpenRouter names: with the maker, and Claude with dots.
  assert.deepEqual(priceOf('openai/gpt-6.2-sol'), PRICES['gpt-6.2-sol'])
  assert.deepEqual(priceOf('anthropic/claude-sonnet-5.5'), PRICES['claude-sonnet-5-5'])
  assert.equal(priceOf('gpt-6-2-astra'), null)
  // A reported cost wins; an unknown model has no price.
  close(estimate({ model: 'openai/gpt-6.2-astra', input: 5_000, cached: 0, output: 5_000, cost: 0.0123 }), 0.0123)
  assert.equal(estimate({ model: 'my-local-model', input: 10, cached: 0, output: 10 }), null)
})

test('the running total adds requests per task, counts unpriced tokens apart, survives a restart and resets', async t => {
  const total = emptyUsage('2026-11-23T00:00:00.000Z')
  addUsage(total, 'translate', { model: 'gpt-6.2-astra', input: 2_000, cached: 0, output: 1_000 })
  addUsage(total, 'coach', { model: 'claude-sonnet-5-5', input: 1_000, cached: 0, output: 500 })
  addUsage(total, 'coach', { model: 'other-model', input: 100, cached: 0, output: 50 })
  close(total.translate.cost, (2_000 * 8 + 1_000 * 40) / 1e6)
  close(total.coach.cost, (1_000 * 2 + 500 * 10) / 1e6)
  assert.deepEqual([total.coach.requests, total.coach.input, total.coach.output, total.coach.unpriced, total.coach.unpricedModels], [2, 1_100, 550, 150, ['other-model']])

  const directory = await mkdtemp(join(tmpdir(), 'tinto-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'ai-usage.json')
  const log = new UsageLog(file)
  await Promise.all([
    log.record('translate', { model: 'gpt-6.2-sol', input: 1_000, cached: 0, output: 1_000 }),
    log.record('coach', { model: 'gpt-6.2-sol', input: 2_000, cached: 0, output: 0 }),
    log.record('coach', { model: 'gpt-6.2-sol', input: 2_000, cached: 0, output: 0 })
  ])
  const saved = await new UsageLog(file).read()
  assert.equal(saved.translate.requests, 1)
  assert.equal(saved.coach.requests, 2, 'requests recorded at the same time are all kept')
  close(saved.coach.cost, 4_000 * 2 / 1e6)
  assert.doesNotMatch(await readFile(file, 'utf8'), /sk-|text|quote/, 'only numbers are stored')
  const reset = await log.reset()
  assert.equal(reset.translate.cost + reset.coach.cost, 0)
  assert.equal((await new UsageLog(file).read()).coach.requests, 0)
})
