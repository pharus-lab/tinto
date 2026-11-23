// Only plain data crosses the preload boundary. Offsets are UTF-16, like
// ProseMirror and JavaScript strings; the engine adapter verifies every span.
export interface WritingReplacement { from: number; to: number; text: string }
export interface DictionaryData { aff: string; dic: string }
export interface WritingDiagnostic {
  from: number
  to: number
  source: string
  category: string
  rule: string
  message: string
  replacements: WritingReplacement[]
}
export interface WritingRequest {
  language: string
  spelling: boolean
  grammar: boolean
  words: string[]
  disabledRules: string[]
  blocks: { id: string; text: string }[]
}
export type WritingFailure = { code: 'unsupported-language' } | { code: 'unavailable' }
export interface WritingResponse { blocks: { id: string; diagnostics: WritingDiagnostic[] }[]; error?: WritingFailure }
export const WRITING_LANGUAGES: [string, string][] = [['en', 'English'], ['en-GB', 'English (UK)'], ['es', 'Spanish']]
export const supportedWritingLanguage = (language: string) => WRITING_LANGUAGES.some(([code]) => code === language)
export const WRITING_BLOCK_LIMIT = 32_000
export const WRITING_BATCH_LIMIT = 64_000
export const english = (language: string) => language === 'en' || language === 'en-GB'
export const dictionaryLanguage = (language: string) => english(language) ? 'en' : language
export const normalizedWord = (word: string) => word.normalize('NFC').replaceAll('’', "'").toLowerCase()
export const validPersonalWord = (word: string) => word.length <= 100 && /^\p{L}[\p{L}\p{M}]*(?:['’\-][\p{L}\p{M}]+)*$/u.test(word)

export function validateWritingRequest(value: unknown): WritingRequest {
  if (!value || typeof value !== 'object') throw Error('Invalid writing check.')
  const v = value as WritingRequest
  if (!supportedWritingLanguage(v.language) || typeof v.spelling !== 'boolean' || typeof v.grammar !== 'boolean' ||
      !Array.isArray(v.words) || v.words.length > 10_000 || v.words.some(word => typeof word !== 'string' || !validPersonalWord(word)) ||
      !Array.isArray(v.disabledRules) || v.disabledRules.length > 2000 || v.disabledRules.some(rule => typeof rule !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(rule)) ||
      !Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > 32 || v.blocks.some(block => !block || typeof block.id !== 'string' || block.id.length > 150 || typeof block.text !== 'string' || block.text.length > WRITING_BLOCK_LIMIT) ||
      v.blocks.reduce((sum, block) => sum + block.text.length, 0) > WRITING_BATCH_LIMIT || new Set(v.blocks.map(block => block.id)).size !== v.blocks.length) {
    throw Error('Invalid writing check.')
  }
  return { language: v.language, spelling: v.spelling, grammar: v.grammar, words: [...v.words], disabledRules: [...v.disabledRules], blocks: v.blocks.map(({ id, text }) => ({ id, text })) }
}

// Harper's Miscellaneous bucket mixes grammar with editorial advice. Only
// these reviewed grammatical rules may escape that bucket. Unknown categories
// are closed by default, including after an engine upgrade.
const miscellaneousGrammar = new Set(['AnA', 'MissingDeterminer', 'MissingPreposition', 'MissingTo', 'InflectedVerbAfterTo', 'ModalBeAdjective', 'DoubleModal', 'DidPast', 'DoNotWant', 'DontCan', 'IsBeenAuxSequence', 'ProgressiveNeedsBe', 'SingleBe', 'ThereMissingIsClause', 'ItTimeAuxiliary'])
const categories = new Set(['Spelling', 'Typo', 'Agreement', 'Grammar', 'Capitalization', 'Punctuation', 'Repetition', 'WordBoundary'])
// Punctuation/grammar categories also contain prescriptive house-style rules.
const editorialRules = new Set(['OxfordComma', 'NoOxfordComma', 'Dashes', 'UseEllipsisCharacter', 'UseTitleCase', 'SpelledNumbers', 'AvoidContractions', 'SentenceLength', 'LongSentences', 'NoFrenchSpaces', 'QuoteStyle', 'OrthographicConsistency'])
export function writingCategory(category: string, rule: string): string | null {
  if (editorialRules.has(rule)) return null
  if (category === 'Miscellaneous') return miscellaneousGrammar.has(rule) ? 'Grammar' : null
  return categories.has(category) ? category : null
}
