// The writing coach: an optional, on-demand review by the writer's AI service.
// It explains problems and suggests improvements; it never changes the text.
// Pure functions shared by the main process (prompt, schema, anchoring) and
// the editor (labels and types).
import { supportedWritingLanguage } from './writing-types'

export const COACH_KINDS = ['grammar', 'punctuation', 'syntax', 'clarity', 'wording', 'concision'] as const
export type CoachKind = typeof COACH_KINDS[number]
export const COACH_LABELS: Record<CoachKind, string> = {
  grammar: 'Grammar', punctuation: 'Punctuation', syntax: 'Sentence structure', clarity: 'Clarity', wording: 'Wording', concision: 'Concision'
}
export interface CoachBlock { id: string; text: string }
// A note the writer resolved: solved (the coach checks the fix next time) or
// dismissed (the writer keeps the wording; the coach does not suggest it again).
// now is the passage as it reads when the next review is sent.
export interface ResolvedNote { outcome: 'solved' | 'dismissed'; kind: CoachKind; title: string; quote: string; now: string }
export interface CoachRequest { language: string; blocks: CoachBlock[]; resolved?: ResolvedNote[] }
// repeat: a note the writer marked solved whose problem is still there.
export interface CoachNote { block: string; quote: string; kind: CoachKind; title: string; explanation: string; suggestion: string; repeat: boolean }
// from and to are UTF-16 offsets of quote in its block's text.
export interface AnchoredNote extends CoachNote { from: number; to: number }
export interface CoachResult { notes: AnchoredNote[]; dropped: number; provider: string; model: string }

// About 10,000 words per review, sent in parts of about 2,000.
export const COACH_LIMIT = 60_000
export const COACH_PART = 12_000
export const COACH_NOTES = 40
export const COACH_RESOLVED = 40
const FIELD = 600

export const COACH_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          block: { type: 'string' },
          quote: { type: 'string' },
          kind: { type: 'string', enum: [...COACH_KINDS] },
          title: { type: 'string' },
          explanation: { type: 'string' },
          suggestion: { type: 'string' },
          repeat: { type: 'boolean' }
        },
        required: ['block', 'quote', 'kind', 'title', 'explanation', 'suggestion', 'repeat'],
        additionalProperties: false
      }
    }
  },
  required: ['notes'],
  additionalProperties: false
}

const DIALECTS: Record<string, { name: string; feedback: string; example: string; norms: string }> = {
  en: {
    name: 'American English', feedback: 'English', example: 'For example:',
    norms: 'Follow American English spelling and punctuation: double quotation marks, with periods and commas inside them.'
  },
  'en-GB': {
    name: 'British English', feedback: 'English', example: 'For example:',
    norms: 'Follow British English spelling (such as -ise, -our and -re) and punctuation, where single quotation marks are common. Do not flag British spellings or usage as errors.'
  },
  es: {
    name: 'Mexican Spanish', feedback: 'Spanish', example: 'Por ejemplo:',
    norms: 'Follow the norms of the RAE and ASALE as used in Mexico: opening ¿ and ¡, the dialogue dash (raya), ustedes rather than vosotros, and Mexican vocabulary and usage. Do not flag Mexican usage as an error.'
  }
}

export function coachInstructions(language: string) {
  const dialect = DIALECTS[language] ?? DIALECTS.en
  return [
    'You are a writing coach reviewing a writer\'s draft in ' + dialect.name + '. You do not edit or rewrite the text: you point out problems and explain how the writer could fix them.',
    'Look for grammar errors; punctuation errors such as missing or misplaced commas, comma splices, run-on sentences, quotation marks and apostrophes; sentence structure that is hard to follow; and wording that is confusing, ambiguous, awkward or needlessly long.',
    'Respect the writer\'s voice and deliberate choices, such as fragments, dialogue, an informal register or rhetorical repetition. Do not comment on the ideas, facts or opinions, and do not raise house-style preferences such as the Oxford comma.',
    dialect.norms,
    'For each problem, give:',
    '- block: the id of the block it is in.',
    '- quote: the shortest passage of that block that shows the problem, copied exactly, character for character, and no longer than one sentence.',
    '- kind: grammar, punctuation, syntax (sentence structure), clarity (confusing or ambiguous), wording (awkward or imprecise word choice) or concision (needlessly long).',
    '- title: a few words naming the problem.',
    '- explanation: one or two sentences on why it is a problem.',
    '- suggestion: how to improve it. Describe the change; when it helps, add one example rewording introduced with "' + dialect.example + '".',
    'Write the title, explanation and suggestion in ' + dialect.feedback + '.',
    'The input may list earlier notes the writer resolved, under resolved, each with the passage as it reads now:',
    '- solved: the writer revised the passage. If the problem is fixed, do not mention it. If the same problem remains, raise it again with repeat set to true and say in the explanation that the revision did not resolve it.',
    '- dismissed: the writer chose to keep that wording. Do not suggest that change again.',
    'Set repeat to false for every other note.',
    'Report at most ' + COACH_NOTES + ' problems, the most important first. Return an empty list when the writing has no problems worth raising.'
  ].join('\n')
}

export function validateCoachRequest(value: unknown): CoachRequest {
  const v = value as CoachRequest
  const invalid = () => Error('Nothing to review.')
  if (!v || typeof v !== 'object' || !supportedWritingLanguage(v.language) || !Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > 5000) throw invalid()
  const blocks: CoachBlock[] = []
  let length = 0
  for (const block of v.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id || block.id.length > 150 || typeof block.text !== 'string') throw invalid()
    length += block.text.length
    if (block.text.trim()) blocks.push({ id: block.id, text: block.text })
  }
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) throw invalid()
  if (length > COACH_LIMIT) throw Error('The writing coach reviews up to about 10,000 words at a time. Check a linked section instead.')
  if (!blocks.length) throw invalid()
  const resolved: ResolvedNote[] = []
  if (v.resolved !== undefined) {
    if (!Array.isArray(v.resolved)) throw invalid()
    for (const item of v.resolved.slice(-COACH_RESOLVED)) {
      if (!item || (item.outcome !== 'solved' && item.outcome !== 'dismissed') || !COACH_KINDS.includes(item.kind) || [item.title, item.quote, item.now].some(text => typeof text !== 'string')) throw invalid()
      resolved.push({ outcome: item.outcome, kind: item.kind, title: clip(item.title), quote: clip(item.quote), now: clip(item.now) })
    }
  }
  return resolved.length ? { language: v.language, blocks, resolved } : { language: v.language, blocks }
}

// Whole blocks per part; a block longer than a part is sent alone.
export function coachParts(blocks: CoachBlock[]): CoachBlock[][] {
  const parts: CoachBlock[][] = []
  let part: CoachBlock[] = [], length = 0
  for (const block of blocks) {
    if (part.length && length + block.text.length > COACH_PART) { parts.push(part); part = []; length = 0 }
    part.push(block); length += block.text.length
  }
  if (part.length) parts.push(part)
  return parts
}

const clip = (text: string) => text.length > FIELD ? text.slice(0, FIELD - 1).trimEnd() + '…' : text
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Models sometimes straighten quotation marks or collapse spaces when quoting.
function tolerant(quote: string) {
  return new RegExp([...quote].map(char => /['‘’]/.test(char) ? "['‘’]" : /["“”«»]/.test(char) ? '["“”«»]' : /\s/.test(char) ? '\\s+' : escape(char)).join('').replace(/(\\s\+)+/g, '\\s+'), 'gu')
}

// Where a quoted passage is in a text now: the match nearest near, allowing
// for straightened quotation marks and collapsed spaces.
export function findPassage(text: string, quote: string, near = 0): { from: number; to: number } | null {
  if (!quote.trim()) return null
  let best: { from: number; to: number } | null = null
  for (const found of text.matchAll(tolerant(quote.trim()))) {
    const from = found.index, to = from + found[0].length
    if (!best || Math.abs(from - near) < Math.abs(best.from - near)) best = { from, to }
  }
  return best
}

// Place each note on the exact passage it quotes. A note whose quote is not in
// its block is dropped: Tinto never marks text the model did not see.
export function anchorNotes(blocks: CoachBlock[], notes: unknown): { notes: AnchoredNote[]; dropped: number } {
  const anchored: AnchoredNote[] = []
  let dropped = 0
  const used = new Set<string>()
  for (const note of Array.isArray(notes) ? notes.slice(0, COACH_NOTES * 2) : []) {
    const n = note as CoachNote
    const block = blocks.find(item => item.id === n?.block)
    const fields = n && typeof n.quote === 'string' && typeof n.title === 'string' && typeof n.explanation === 'string' && typeof n.suggestion === 'string'
    const quote = fields ? n.quote.trim() : ''
    if (!block || !fields || !COACH_KINDS.includes(n.kind) || !quote || quote.length > 1000 || !n.explanation.trim()) { dropped++; continue }
    let match: { from: number; to: number } | undefined
    for (const found of block.text.matchAll(tolerant(quote))) {
      const from = found.index, to = from + found[0].length
      if (!used.has(block.id + ':' + from + ':' + to + ':' + n.kind)) { match = { from, to }; break }
    }
    if (!match) { dropped++; continue }
    used.add(block.id + ':' + match.from + ':' + match.to + ':' + n.kind)
    anchored.push({ block: block.id, quote: block.text.slice(match.from, match.to), kind: n.kind, title: clip(n.title.trim()) || COACH_LABELS[n.kind], explanation: clip(n.explanation.trim()), suggestion: clip(n.suggestion.trim()), repeat: n.repeat === true, ...match })
    if (anchored.length === COACH_NOTES) break
  }
  return { notes: anchored, dropped }
}
