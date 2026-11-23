// An estimate of what Translate and the writing coach cost: the tokens each AI
// service reports for a request, priced from the published rates below. The
// provider's bill is exact; this is a guide. Only numbers are stored: no text,
// no keys.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type UsageTask = 'translate' | 'coach'
// What a service reported for one request.
export interface RequestUsage { model: string; input: number; cached: number; output: number; cost?: number }
export interface TaskUsage { cost: number; input: number; output: number; requests: number; unpriced: number; unpricedModels: string[] }
export interface UsageTotal { since: string; translate: TaskUsage; coach: TaskUsage }

// US dollars per million tokens (input, cached input, output), short-context
// standard rates published on 2026-11-23.
export const PRICES_AS_OF = '2026-11-23'
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.2-astra': { input: 8, cached: 0.4, output: 40 },
  'gpt-6.2-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'claude-opus-5-5': { input: 4, cached: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cached: 0.1, output: 10 }
}
// OpenRouter names models with their maker, and Claude versions with dots.
export function priceOf(model: string) {
  let id = model.replace(/^(openai|anthropic)\//, '')
  if (id.startsWith('claude-')) id = id.replace(/(\d)\.(\d)/g, '$1-$2')
  return PRICES[id] ?? null
}
// The dollars for one request, or null when the model has no known price.
export function estimate(usage: RequestUsage): number | null {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost
  const price = priceOf(usage.model)
  if (!price) return null
  const cached = Math.min(usage.cached, usage.input)
  return ((usage.input - cached) * price.input + cached * price.cached + usage.output * price.output) / 1_000_000
}

const empty = (): TaskUsage => ({ cost: 0, input: 0, output: 0, requests: 0, unpriced: 0, unpricedModels: [] })
export const emptyUsage = (since = new Date().toISOString()): UsageTotal => ({ since, translate: empty(), coach: empty() })
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

export function addUsage(total: UsageTotal, task: UsageTask, usage: RequestUsage): UsageTotal {
  const item = total[task], cost = estimate(usage)
  item.requests++
  item.input += count(usage.input)
  item.output += count(usage.output)
  if (cost === null) {
    item.unpriced += count(usage.input) + count(usage.output)
    if (!item.unpricedModels.includes(usage.model)) item.unpricedModels = [...item.unpricedModels, usage.model].slice(-10)
  } else item.cost += cost
  return total
}

// The total since the writer started or last reset, kept in one small file.
export class UsageLog {
  private queue = Promise.resolve()
  constructor(private file: string) {}
  async read(): Promise<UsageTotal> {
    if (!existsSync(this.file)) return emptyUsage()
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<UsageTotal>
      const task = (value: Partial<TaskUsage> | undefined): TaskUsage => ({ cost: Number(value?.cost) || 0, input: count(value?.input), output: count(value?.output), requests: count(value?.requests), unpriced: count(value?.unpriced), unpricedModels: Array.isArray(value?.unpricedModels) ? value.unpricedModels.filter(model => typeof model === 'string').slice(-10) : [] })
      return { since: typeof saved.since === 'string' ? saved.since : new Date().toISOString(), translate: task(saved.translate), coach: task(saved.coach) }
    } catch { return emptyUsage() }
  }
  private write(total: UsageTotal) {
    const temporary = this.file + '.tmp'
    return mkdir(dirname(this.file), { recursive: true }).then(() => writeFile(temporary, JSON.stringify(total))).then(() => rename(temporary, this.file))
  }
  // Requests are recorded one after another, so none is lost.
  record(task: UsageTask, usage: RequestUsage): Promise<void> {
    this.queue = this.queue.then(async () => { await this.write(addUsage(await this.read(), task, usage)) }).catch(() => {})
    return this.queue
  }
  reset(): Promise<UsageTotal> {
    const total = emptyUsage()
    this.queue = this.queue.then(() => this.write(total)).catch(() => {})
    return this.queue.then(() => total)
  }
}
