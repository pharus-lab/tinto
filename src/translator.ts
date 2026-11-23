import Anthropic from '@anthropic-ai/sdk'
import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { protect, reveal } from './secure-file'
import { translationParts, type SourceBlock, type TranslationResult, type TranslationSource } from './translation'
import type { TranslatorSummary } from './project-types'
import { anchorNotes, coachInstructions, coachParts, COACH_SCHEMA, validateCoachRequest, type CoachRequest, type CoachResult } from './writing-coach'

// The writer's AI service, with their own API key: OpenAI, Anthropic (Claude)
// or OpenRouter, each asked for a strict JSON schema. It translates documents
// and runs the writing coach. Only the text the writer chooses to translate or
// review is sent, and providers that store responses are asked not to.
export type ProviderId = 'openai' | 'anthropic' | 'openrouter'
export const PROVIDERS: Record<ProviderId, { name: string; model: string }> = {
  openai: { name: 'OpenAI', model: 'gpt-6.2-astra' },
  anthropic: { name: 'Anthropic', model: 'claude-opus-5-5' },
  openrouter: { name: 'OpenRouter', model: 'openai/gpt-6.2-astra' }
}
export const DEFAULT_MODEL = PROVIDERS.openai.model
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/
export interface TranslatorSettings { provider: ProviderId; key: string; model: string }
export type Fetch = (input: string, init: RequestInit) => Promise<Response>
const realFetch: Fetch = (input, init) => globalThis.fetch(input, init)

// Spanish documents (es) are written and translated in Mexican Spanish.
export const languageName = (code: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code === 'es' ? 'es-MX' : code) ?? code } catch { return code }
}
const BLOCKS = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    blocks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } }
  },
  required: ['title', 'blocks'],
  additionalProperties: false
}
const TEXTS = { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'], additionalProperties: false }
// What the service is asked to do, for its error messages.
export type Task = 'translate' | 'review'
const TASK = {
  translate: { verb: 'translate', again: 'translate again', unreadable: 'The translation came back in a form Tinto could not read. Translate again.', long: 'The translation was longer than {name} could return at once. Split the document and translate again.', stopped: '{name} stopped before finishing the translation. Translate again.', shorter: 'translate a shorter document' },
  review: { verb: 'review', again: 'check again', unreadable: 'The writing coach\'s answer came back in a form Tinto could not read. Check again.', long: 'The writing coach had more to say than {name} could return at once. Check a shorter section.', stopped: '{name} stopped before finishing the review. Check again.', shorter: 'check a shorter section' }
}
const unreadable = (task: Task = 'translate') => Error(TASK[task].unreadable)
const wait = () => new Promise(done => setTimeout(done, 1500))

export function manuscriptInstructions(from: string, to: string) {
  return [
    'You translate a writer\'s manuscript from ' + languageName(from) + ' into ' + languageName(to) + ' for publication.',
    'Translate the title and every block faithfully. Keep the author\'s voice, tone, register and paragraphing.',
    'Do not add, omit, summarize, explain or comment on anything.',
    'The inline tags <b>, <i> and <u> mark bold, italic and underlined words. Put them around the words that correspond to the tagged words of the original. Keep the entities &amp;, &lt; and &gt; as they are.',
    'Return exactly one block for each input block, with the same id, in the same order.'
  ].join('\n')
}
function fieldInstructions(from: string, to: string) {
  return 'Translate each text from ' + languageName(from) + ' into ' + languageName(to) + ' for publication, keeping its tone. Do not add or explain anything. Return the same number of texts, in the same order; an empty text stays empty.'
}

// What every provider shares: splitting a manuscript into parts and checking
// that what comes back has the shape Tinto asked for.
abstract class Translator {
  constructor(protected readonly settings: TranslatorSettings, protected readonly fetcher: Fetch = realFetch) {}
  protected get name() { return PROVIDERS[this.settings.provider].name }
  // A key that can use the model can translate with it.
  abstract check(): Promise<void>
  protected abstract respond(instructions: string, input: object, name: string, schema: object, task: Task): Promise<string>
  private async ask<T>(instructions: string, input: object, name: string, schema: object, task: Task = 'translate'): Promise<T> {
    const output = await this.respond(instructions, input, name, schema, task)
    try { return JSON.parse(output) as T } catch { throw unreadable(task) }
  }

  // The writing coach: notes on the chosen wording, each placed on the exact
  // passage it quotes. Nothing in the manuscript is changed.
  async coach(request: CoachRequest, progress: (done: number, total: number) => void = () => {}): Promise<CoachResult> {
    const parts = coachParts(request.blocks)
    const notes: CoachResult['notes'] = []
    let dropped = 0
    progress(0, parts.length)
    for (const [index, part] of parts.entries()) {
      const result = await this.ask<{ notes: unknown }>(coachInstructions(request.language), { blocks: part }, 'coaching', COACH_SCHEMA, 'review')
      if (!Array.isArray(result?.notes)) throw unreadable('review')
      const anchored = anchorNotes(part, result.notes)
      notes.push(...anchored.notes); dropped += anchored.dropped
      progress(index + 1, parts.length)
    }
    return { notes, dropped, provider: this.name, model: this.settings.model }
  }

  async translate(source: TranslationSource, from: string, to: string, progress: (done: number, total: number) => void = () => {}): Promise<TranslationResult> {
    const parts = translationParts(source.blocks)
    const blocks: SourceBlock[] = []
    let title = source.title
    progress(0, parts.length)
    for (const [index, part] of parts.entries()) {
      const result = await this.ask<TranslationResult>(manuscriptInstructions(from, to), { title: source.title, blocks: part }, 'translation', BLOCKS)
      if (typeof result?.title !== 'string' || !Array.isArray(result.blocks) || result.blocks.some(block => typeof block?.id !== 'string' || typeof block?.text !== 'string')) throw unreadable()
      if (index === 0) title = result.title.trim() || source.title
      blocks.push(...result.blocks)
      progress(index + 1, parts.length)
    }
    return { title, blocks }
  }

  async translateTexts(texts: string[], from: string, to: string): Promise<string[]> {
    if (!texts.some(text => text.trim())) return texts
    const result = await this.ask<{ texts: string[] }>(fieldInstructions(from, to), { texts }, 'texts', TEXTS)
    if (!Array.isArray(result?.texts) || result.texts.length !== texts.length || result.texts.some(text => typeof text !== 'string')) throw unreadable()
    return result.texts.map((text, index) => texts[index].trim() ? text : '')
  }
}

// OpenAI and OpenRouter: the Responses API with a strict JSON schema.
class ResponsesTranslator extends Translator {
  private get api() { return this.settings.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1' }

  async check() {
    if (this.settings.provider === 'openai') return void await this.call('/models/' + encodeURIComponent(this.settings.model), { method: 'GET' }, 30_000)
    // OpenRouter: the key is checked, and the model must exist and accept a strict schema.
    await this.call('/key', { method: 'GET' }, 30_000)
    const listed = await this.call('/models', { method: 'GET' }, 30_000) as { data?: { id?: string; supported_parameters?: string[] }[] }
    const model = listed?.data?.find(item => item?.id === this.settings.model)
    if (!model) throw Error('OpenRouter has no model named ' + this.settings.model + '. Copy its id from openrouter.ai/models, such as ' + PROVIDERS.openrouter.model + '.')
    if (!model.supported_parameters?.includes('structured_outputs')) throw Error(this.settings.model + ' does not return structured output on OpenRouter, which Tinto needs to keep paragraphs in place. Choose another model.')
  }

  protected async respond(instructions: string, input: object, name: string, schema: object, task: Task): Promise<string> {
    const body = await this.call('/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model, instructions, input: JSON.stringify(input),
        text: { format: { type: 'json_schema', name, strict: true, schema } }, store: false, max_output_tokens: 32_000,
        // Only providers that honor the schema may answer.
        ...(this.settings.provider === 'openrouter' ? { provider: { require_parameters: true } } : {})
      })
    }, 600_000, task) as { status?: string; incomplete_details?: { reason?: string }; output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[] }
    if (body?.status === 'incomplete') {
      throw Error((body.incomplete_details?.reason === 'max_output_tokens' ? TASK[task].long : TASK[task].stopped).replace('{name}', this.name))
    }
    const content = body?.output?.find(item => item?.type === 'message')?.content ?? []
    const refusal = content.find(part => part?.type === 'refusal')
    if (refusal) throw Error(this.name + ' declined to ' + TASK[task].verb + ' this text' + (refusal.refusal ? ': ' + refusal.refusal : '.'))
    return String(content.find(part => part?.type === 'output_text')?.text)
  }

  // A busy service or a dropped connection gets one more try.
  private async call(path: string, init: RequestInit, timeout: number, task: Task = 'translate'): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let response: Response
      try {
        response = await this.fetcher(this.api + path, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + this.settings.key, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') throw Error(this.name + ' took too long to answer. Try again, or ' + TASK[task].shorter + '.')
        if (attempt < 2) { await wait(); continue }
        throw Error('Tinto could not reach ' + this.name + '. Check your connection and try again.')
      }
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
      if (response.ok) return body
      if (response.status >= 500 && attempt < 2) { await wait(); continue }
      throw explain(this.name, this.settings.model, response.status, body?.error?.code, task)
    }
  }
}

// Anthropic: the Messages API through Anthropic's SDK, with a JSON output format.
class ClaudeTranslator extends Translator {
  private readonly client = new Anthropic({ apiKey: this.settings.key, fetch: this.fetcher as never, maxRetries: 1, timeout: 600_000 })

  async check() {
    try { await this.client.models.retrieve(this.settings.model) } catch (error) { throw this.failure(error) }
  }

  protected async respond(instructions: string, input: object, _name: string, schema: object, task: Task): Promise<string> {
    const { model } = this.settings
    // The current Claude models take an effort level; on a refusal, the API
    // can finish the request with another model in the same call.
    const current = /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model)
    const fallback = /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model)
    let message
    try {
      message = await this.client.beta.messages.create({
        model, max_tokens: 16_000, system: instructions,
        messages: [{ role: 'user', content: JSON.stringify(input) }],
        output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> }, ...(current ? { effort: 'medium' as const } : {}) },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      })
    } catch (error) { throw this.failure(error, task) }
    if (message.stop_reason === 'refusal') throw Error('Claude declined to ' + TASK[task].verb + ' this text.')
    if (message.stop_reason === 'max_tokens') throw Error(TASK[task].long.replace('{name}', 'Claude'))
    const text = message.content.find(block => block.type === 'text')
    return text?.type === 'text' ? text.text : ''
  }

  private failure(error: unknown, task: Task = 'translate'): Error {
    if (error instanceof Anthropic.APIConnectionTimeoutError) return Error('Anthropic took too long to answer. Try again, or ' + TASK[task].shorter + '.')
    if (error instanceof Anthropic.APIConnectionError) return Error('Tinto could not reach Anthropic. Check your connection and try again.')
    if (error instanceof Anthropic.APIError && typeof error.status === 'number') return explain(this.name, this.settings.model, error.status, undefined, task)
    return error instanceof Error ? error : Error(String(error))
  }
}

function explain(name: string, model: string, status: number, code?: string, task: Task = 'translate'): Error {
  if (status === 401) return Error(name + ' rejected the API key. Check it in Settings → Writing → AI service.')
  if (status === 402 || (status === 429 && code === 'insufficient_quota')) return Error('Your ' + name + ' account has no credit left. Add credit, then ' + TASK[task].again + '.')
  if (status === 403) return Error('This ' + name + ' key cannot use ' + model + '. Choose another model in Settings → Writing.')
  if (status === 404) return Error(name + ' has no model named ' + model + ' for this key. Check the model in Settings → Writing.')
  if (status === 429) return Error(name + ' is limiting requests for this key. Wait a minute and ' + TASK[task].again + '.')
  if (status >= 500) return Error(name + ' is unavailable right now. Try again in a minute.')
  return Error(name + ' could not ' + TASK[task].verb + ' this text (error ' + status + ').')
}

export function createTranslator(settings: TranslatorSettings, fetcher: Fetch = realFetch): Translator {
  return settings.provider === 'anthropic' ? new ClaudeTranslator(settings, fetcher) : new ResponsesTranslator(settings, fetcher)
}
// Settings saved before providers existed were OpenAI's.
const migrate = (saved: Partial<TranslatorSettings>): TranslatorSettings => ({ provider: saved.provider && saved.provider in PROVIDERS ? saved.provider : 'openai', key: String(saved.key ?? ''), model: String(saved.model ?? DEFAULT_MODEL) })

interface TranslatorContext { trusted(event: Electron.IpcMainInvokeEvent): void }

export function registerTranslation(context: TranslatorContext) {
  // The key and the model, encrypted with the system keychain.
  const file = join(app.getPath('userData'), 'translation.enc')
  const purpose = 'translate documents'
  async function settings(): Promise<TranslatorSettings | null> {
    return existsSync(file) ? migrate(JSON.parse(await reveal(file, purpose))) : null
  }
  async function translator() {
    const saved = await settings()
    if (!saved) throw Error('Add an API key in Settings → Writing → AI service.')
    return createTranslator(saved)
  }
  const summary = (saved: TranslatorSettings | null): TranslatorSummary | null => saved ? { provider: saved.provider, name: PROVIDERS[saved.provider].name, model: saved.model } : null

  ipcMain.handle('translator:status', async event => { context.trusted(event); return summary(await settings()) })
  ipcMain.handle('translator:save', async (event, provider: unknown, key: unknown, model: unknown) => {
    context.trusted(event)
    const id = typeof provider === 'string' && provider in PROVIDERS ? provider as ProviderId : 'openai'
    const saved: TranslatorSettings = { provider: id, key: typeof key === 'string' ? key.trim() : '', model: typeof model === 'string' && model.trim() ? model.trim() : PROVIDERS[id].model }
    if (saved.key.length < 20 || /\s/.test(saved.key)) throw Error('Paste the whole ' + PROVIDERS[id].name + ' API key.')
    if (!MODEL_ID.test(saved.model)) throw Error('Write the model as ' + PROVIDERS[id].name + ' names it, such as ' + PROVIDERS[id].model + '.')
    await createTranslator(saved).check()
    await protect(file, JSON.stringify(saved), purpose)
    return summary(saved)
  })
  ipcMain.handle('translator:test', async event => { context.trusted(event); await (await translator()).check(); return summary(await settings()) })
  ipcMain.handle('translator:remove', async event => { context.trusted(event); await rm(file, { force: true }) })
  ipcMain.handle('translator:translate', async (event, source: TranslationSource, from: string, to: string) => {
    context.trusted(event)
    return (await translator()).translate(source, from, to, (done, total) => {
      if (!event.sender.isDestroyed()) event.sender.send('translator:progress', done, total)
    })
  })
  // The writing coach reviews only what the writer sends with Check writing.
  ipcMain.handle('coach:review', async (event, request: unknown) => {
    context.trusted(event)
    const valid = validateCoachRequest(request)
    return (await translator()).coach(valid, (done, total) => {
      if (!event.sender.isDestroyed()) event.sender.send('coach:progress', done, total)
    })
  })
  ipcMain.handle('translator:texts', async (event, texts: string[], from: string, to: string) => {
    context.trusted(event)
    if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw Error('Nothing to translate.')
    return (await translator()).translateTexts(texts, from, to)
  })
}
