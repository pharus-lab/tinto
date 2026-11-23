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
  // Style hints (wordiness, long sentences) join English grammar checks when true.
  style?: boolean
  words: string[]
  disabledRules: string[]
  blocks: { id: string; text: string }[]
}
export type WritingFailure = { code: 'unsupported-language' } | { code: 'unavailable' }
export interface WritingResponse { blocks: { id: string; diagnostics: WritingDiagnostic[] }[]; error?: WritingFailure }
// Spanish documents keep the code es and follow Mexican Spanish.
export const WRITING_LANGUAGES: [string, string][] = [['en', 'English'], ['en-GB', 'English (UK)'], ['es', 'Spanish (Mexico)']]
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
  if (!supportedWritingLanguage(v.language) || typeof v.spelling !== 'boolean' || typeof v.grammar !== 'boolean' || (v.style !== undefined && typeof v.style !== 'boolean') ||
      !Array.isArray(v.words) || v.words.length > 10_000 || v.words.some(word => typeof word !== 'string' || !validPersonalWord(word)) ||
      !Array.isArray(v.disabledRules) || v.disabledRules.length > 2000 || v.disabledRules.some(rule => typeof rule !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(rule)) ||
      !Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > 32 || v.blocks.some(block => !block || typeof block.id !== 'string' || block.id.length > 150 || typeof block.text !== 'string' || block.text.length > WRITING_BLOCK_LIMIT) ||
      v.blocks.reduce((sum, block) => sum + block.text.length, 0) > WRITING_BATCH_LIMIT || new Set(v.blocks.map(block => block.id)).size !== v.blocks.length) {
    throw Error('Invalid writing check.')
  }
  return { language: v.language, spelling: v.spelling, grammar: v.grammar, style: v.style === true, words: [...v.words], disabledRules: [...v.disabledRules], blocks: v.blocks.map(({ id, text }) => ({ id, text })) }
}

// Harper's Miscellaneous bucket mixes grammar with editorial advice. Only
// these reviewed grammatical rules may escape that bucket. Unknown categories
// are closed by default, including after an engine upgrade.
const miscellaneousGrammar = new Set(['AnA', 'MissingDeterminer', 'MissingPreposition', 'MissingTo', 'InflectedVerbAfterTo', 'ModalBeAdjective', 'DoubleModal', 'DidPast', 'DoNotWant', 'DontCan', 'IsBeenAuxSequence', 'ProgressiveNeedsBe', 'SingleBe', 'ThereMissingIsClause', 'ItTimeAuxiliary', 'ThenThan', 'Everyone', 'SinceDuration'])
// Harper's kinds (harper.js 3.2.0) and how Tinto names them. Errors are shown
// with grammar; wordiness and readability only as style hints.
const categories: Record<string, string> = {
  Spelling: 'Spelling', Typo: 'Typo', Agreement: 'Agreement', Grammar: 'Grammar', Capitalization: 'Capitalization', Punctuation: 'Punctuation',
  Repetition: 'Repetition', BoundaryError: 'Word boundary', WordChoice: 'Word choice', Usage: 'Usage', WordOrder: 'Word order',
  Eggcorn: 'Idiom', Malapropism: 'Idiom', Nonstandard: 'Idiom', Formatting: 'Spacing'
}
const styleKinds = new Set(['Redundancy', 'Readability', 'Style'])
// Double comparatives are filed as redundancy but are grammatical errors.
const redundantGrammar = new Set(['AdjectiveDoubleDegree', 'MoreBetter'])
// Advice about style rather than an error, shown only with style hints.
const styleRules = new Set(['VeryUnique', 'CondenseAllThe', 'RedundantAcronyms'])
// Prescriptive house-style rules are never shown.
const editorialRules = new Set(['OxfordComma', 'NoOxfordComma', 'Dashes', 'UseEllipsisCharacter', 'UseTitleCase', 'SpelledNumbers', 'AvoidContractions', 'NoFrenchSpaces', 'QuoteStyle', 'OrthographicConsistency'])
export const STYLE_CATEGORY = 'Style'
export function writingCategory(category: string, rule: string, style = false): string | null {
  if (editorialRules.has(rule)) return null
  if (styleRules.has(rule)) return style ? STYLE_CATEGORY : null
  if (category === 'Miscellaneous') return miscellaneousGrammar.has(rule) ? 'Grammar' : null
  if (styleKinds.has(category)) return redundantGrammar.has(rule) ? 'Grammar' : style ? STYLE_CATEGORY : null
  return categories[category] ?? null
}
