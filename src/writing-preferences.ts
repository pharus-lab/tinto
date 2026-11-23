import { dictionaryLanguage, normalizedWord, supportedWritingLanguage, validPersonalWord } from './writing-types'

export interface WritingPreferences { spelling: boolean; grammar: boolean; words: Record<string, string[]>; disabledRules: string[] }
const key = 'writing-checks'
const eventName = 'tinto-writing-preferences'
export function writingPreferences(): WritingPreferences {
  let saved: Partial<WritingPreferences> = {}
  try { saved = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {} } catch { /* Keep editing if a preference is damaged. */ }
  const words: Record<string, string[]> = {}
  for (const [language, list] of Object.entries(saved.words ?? {})) {
    // Retain vocabulary from older installations without offering that language.
    if (!['en', 'es', 'fr'].includes(language) || !Array.isArray(list)) continue
    words[language] = list.filter(word => typeof word === 'string' && validPersonalWord(word)).slice(0, 10_000)
  }
  return { spelling: saved.spelling === true, grammar: saved.grammar === true, words, disabledRules: Array.isArray(saved.disabledRules) ? saved.disabledRules.filter(rule => typeof rule === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(rule)).slice(0, 2000) : [] }
}
export function saveWritingPreferences(prefs: WritingPreferences) {
  try { localStorage.setItem(key, JSON.stringify(prefs)) }
  catch { throw Error('Writing settings could not be saved. Your previous settings are still in use. Check available storage and try again.') }
  window.dispatchEvent(new Event(eventName))
}
export function observeWritingPreferences(listener: (prefs: WritingPreferences) => void) {
  const changed = () => listener(writingPreferences())
  const storage = (event: StorageEvent) => { if (event.key === key) changed() }
  window.addEventListener(eventName, changed)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(eventName, changed); window.removeEventListener('storage', storage) }
}
export function acceptWord(language: string, word: string) {
  if (!supportedWritingLanguage(language)) throw Error('Personal dictionaries support English, English (UK), and Spanish.')
  word = word.trim().normalize('NFC')
  if (!validPersonalWord(word)) throw Error('Enter one word, with letters, apostrophes or hyphens.')
  const prefs = writingPreferences(), code = dictionaryLanguage(language)
  const list = prefs.words[code] ??= []
  if (!list.some(item => normalizedWord(item) === normalizedWord(word))) {
    if (list.length >= 10_000) throw Error('This dictionary is full. Remove a word before adding another.')
    list.push(word)
    list.sort((a, b) => a.localeCompare(b))
    saveWritingPreferences(prefs)
    return true
  }
  return false
}
export function disableWritingRule(rule: string) {
  const prefs = writingPreferences()
  if (!prefs.disabledRules.includes(rule)) { prefs.disabledRules.push(rule); saveWritingPreferences(prefs) }
}
