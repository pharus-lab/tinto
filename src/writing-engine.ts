import { LocalLinter, Dialect, SuggestionKind } from 'harper.js'
import { binaryInlined } from 'harper.js/binaryInlined'
import nspell from 'nspell'
import { english, normalizedWord, writingCategory, type WritingDiagnostic, type WritingRequest, type WritingResponse } from './writing-types'
import type { DictionaryData } from './writing-types'

// Constructed only in the Node worker. The full WASM is a bundled data URL;
// Harper never fetches a remote binary and the renderer never executes WASM.
export class WritingEngine {
  private linter?: LocalLinter
  private configuration = ''
  private dictionaries = new Map<string, ReturnType<typeof nspell>>()
  constructor(private readDictionary: (language: string) => Promise<DictionaryData>) {}

  async check(request: WritingRequest): Promise<WritingResponse> {
    const words = new Set(request.words.map(normalizedWord))
    const blocks: WritingResponse['blocks'] = []
    if (english(request.language)) {
      this.linter ??= new LocalLinter({ binary: binaryInlined })
      const linter = this.linter
      const configuration = JSON.stringify([request.language, request.spelling, request.grammar, request.words, request.disabledRules])
      const style = request.grammar && request.style === true
      if (configuration !== this.configuration) {
        await linter.setDialect(request.language === 'en-GB' ? Dialect.British : Dialect.American)
        const defaults = await linter.getDefaultLintConfig()
        const disabled = new Set(request.disabledRules)
        const config = Object.fromEntries(Object.entries(defaults).map(([rule, enabled]) => [rule, rule === 'SpellCheck' ? request.spelling : request.grammar && !disabled.has(rule) && enabled]))
        await linter.setLintConfig(config)
        await linter.clearWords()
        if (request.words.length) await linter.importWords(request.words)
        this.configuration = configuration
      }
      for (const block of request.blocks) {
        const diagnostics: WritingDiagnostic[] = []
        const groups = await linter.organizedLints(block.text, { language: 'plaintext', dedup: false })
        for (const [rule, lints] of Object.entries(groups)) for (const lint of lints) {
          try {
            const category = writingCategory(lint.lint_kind(), rule, style)
            if (!category || (category === 'Spelling' ? !request.spelling : !request.grammar) || request.disabledRules.includes(rule)) continue
            const span = lint.span()
            // harper.js 3.2.0 exposes UTF-16 spans (its core uses Unicode
            // scalar spans internally). Never apply an unverified conversion.
            const { start: from, end: to } = span
            span.free()
            const source = lint.get_problem_text()
            if (from < 0 || to > block.text.length || from >= to || block.text.slice(from, to) !== source) continue
            if (category === 'Spelling' && words.has(normalizedWord(source))) continue
            const suggestions = lint.suggestions()
            const replacements: WritingDiagnostic['replacements'] = []
            for (const suggestion of suggestions) {
              try {
                const kind = suggestion.kind()
                if (kind === SuggestionKind.Replace || kind === SuggestionKind.Remove || kind === SuggestionKind.InsertAfter) {
                  replacements.push({ from: kind === SuggestionKind.InsertAfter ? to : from, to, text: kind === SuggestionKind.Remove ? '' : suggestion.get_replacement_text() })
                }
              } finally { suggestion.free() }
            }
            diagnostics.push({ from, to, source, category, rule, message: lint.message(), replacements: replacements.slice(0, 7) })
          } finally { lint.free() }
        }
        blocks.push({ id: block.id, diagnostics: diagnostics.sort((a, b) => a.from - b.from || a.to - b.to) })
      }
    } else {
      let dictionary = this.dictionaries.get(request.language)
      if (request.spelling && !dictionary) {
        const { aff, dic } = await this.readDictionary(request.language)
        dictionary = nspell(aff, dic)
        this.dictionaries.set(request.language, dictionary)
      }
      for (const block of request.blocks) {
        const diagnostics: WritingDiagnostic[] = []
        if (request.spelling) for (const match of block.text.matchAll(/\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu)) {
          const source = match[0], from = match.index, to = from + source.length
          const word = source.normalize('NFC').replaceAll('’', "'")
          if (words.has(normalizedWord(source)) || dictionary!.correct(word)) continue
          diagnostics.push({ from, to, source, category: 'Spelling', rule: 'SpellCheck', message: 'This word is not in the spelling dictionary.', replacements: dictionary!.suggest(word).slice(0, 7).map(text => ({ from, to, text })) })
        }
        blocks.push({ id: block.id, diagnostics })
      }
    }
    return { blocks }
  }
}
