import nspell from 'nspell'
import type { Node } from 'prosemirror-model'
import { closeHistory } from 'prosemirror-history'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

export interface DictionaryData { aff: string; dic: string }
export interface Spelling { language: string; correct(word: string): boolean; suggest(word: string): string[] }
export type DictionaryLoader = (language: string) => Promise<DictionaryData>

async function bundledDictionary(language: string): Promise<DictionaryData> {
  const read = async (extension: string) => {
    const source = new URL('./dictionaries/' + language + '.' + extension, document.baseURI)
    const response = await fetch(source)
    if (!response.ok) throw new Error('Could not open the ' + language + ' dictionary.')
    return response.text()
  }
  const [aff, dic] = await Promise.all([read('aff'), read('dic')])
  return { aff, dic }
}

const dictionaries = new Map<string, Promise<Spelling>>()

export function loadSpelling(language: string, load: DictionaryLoader = bundledDictionary): Promise<Spelling> {
  const existing = dictionaries.get(language)
  if (existing) return existing
  const pending = load(language).then(data => {
    const dictionary = nspell(data.aff, data.dic)
    return {
      language,
      correct: (word: string) => dictionary.correct(word.replaceAll('’', "'")),
      suggest: (word: string) => dictionary.suggest(word.replaceAll('’', "'")).slice(0, 7)
    }
  }).catch(error => {
    dictionaries.delete(language)
    throw error
  })
  dictionaries.set(language, pending)
  return pending
}

interface Word { from: number; to: number; word: string }
export interface Correction extends Word { suggestions: string[] }
interface CheckedDocument { checker: Spelling; decorations: DecorationSet }
export const spellingKey = new PluginKey<CheckedDocument>('tintoSpelling')

// Adjacent text nodes can divide a single word wherever the writer used emphasis.
function checkBlock(block: Node, checker: Spelling): Word[] {
  const errors: Word[] = []
  function visit(parent: Node, start: number) {
    let phrase = ''
    let first = start
    function checkPhrase() {
      for (const match of phrase.matchAll(/\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu)) {
        const word = match[0]
        if (!checker.correct(word)) {
          const from = first + match.index
          errors.push({ word, from, to: from + word.length })
        }
      }
      phrase = ''
    }
    parent.forEach((child, offset) => {
      if (child.isText) {
        if (!phrase) first = start + offset
        phrase += child.text
      } else {
        checkPhrase()
        if (child.content.size) visit(child, start + offset + 1)
      }
    })
    checkPhrase()
  }
  visit(block, 1)
  return errors
}

export function spellingAt(view: EditorView, position: number): Correction | null {
  const state = spellingKey.getState(view.state)
  const range = state?.decorations.find(position, position)[0]
  if (!state || !range) return null
  const { word } = range.spec
  return { word, from: range.from, to: range.to, suggestions: state.checker.suggest(word) }
}

export function correctSpelling(view: EditorView, correction: Correction, replacement: string) {
  const { from, to, word } = correction
  if (view.state.doc.textBetween(from, to) !== word || !correction.suggestions.includes(replacement)) return false
  // Replace just the changed letters so emphasis on the common ends survives.
  let left = 0
  let right = 0
  const shared = Math.min(word.length, replacement.length)
  while (left < shared && word[left] === replacement[left]) left++
  while (right < shared - left && word.at(-right - 1) === replacement.at(-right - 1)) right++
  const transaction = closeHistory(view.state.tr)
  transaction.insertText(replacement.slice(left, replacement.length - right), from + left, to - right)
  view.dispatch(transaction)
  view.focus()
  return true
}

export function setSpellingLanguage(view: EditorView, checker: Spelling) {
  view.dispatch(view.state.tr.setMeta(spellingKey, checker).setMeta('addToHistory', false))
}

export function spellingPlugin(initial: Spelling): Plugin<CheckedDocument> {
  let cache = new WeakMap<Node, Word[]>()
  let dismiss: (() => void) | undefined

  function check(doc: Node, checker: Spelling): CheckedDocument {
    const decorations: Decoration[] = []
    doc.forEach((block, offset) => {
      const errors = cache.get(block) ?? checkBlock(block, checker)
      cache.set(block, errors)
      for (const { from, to, word } of errors) {
        decorations.push(Decoration.inline(offset + from, offset + to, { class: 'tinto-misspelling', 'data-word': word }, { word }))
      }
    })
    return { checker, decorations: DecorationSet.create(doc, decorations) }
  }

  function showSuggestions(view: EditorView, position: number, x: number, y: number) {
    const correction = spellingAt(view, position)
    if (!correction) return false
    dismiss?.()
    const doc = view.dom.ownerDocument
    const menu = doc.createElement('div')
    menu.className = 'tinto-spelling-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Spelling suggestions for ' + correction.word)
    const caption = doc.createElement('div')
    caption.textContent = correction.suggestions.length ? 'Spelling suggestions' : 'No suggestions'
    menu.append(caption)
    for (const word of correction.suggestions) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = word
      button.onclick = () => { dismiss?.(); correctSpelling(view, correction, word) }
      menu.append(button)
    }
    function outside(event: Event) {
      if (!menu.contains(event.target as globalThis.Node)) dismiss?.()
    }
    dismiss = () => {
      doc.removeEventListener('pointerdown', outside, true)
      doc.removeEventListener('focusin', outside, true)
      doc.removeEventListener('scroll', outside, true)
      menu.remove()
      dismiss = undefined
    }
    menu.onkeydown = event => {
      const buttons = Array.from(menu.querySelectorAll('button'))
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss?.()
        view.focus()
      } else if (buttons.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        buttons[(buttons.indexOf(doc.activeElement as HTMLButtonElement) + direction + buttons.length) % buttons.length].focus()
      }
    }
    doc.body.append(menu)
    menu.style.left = Math.max(4, Math.min(x, doc.documentElement.clientWidth - menu.offsetWidth - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(y, doc.documentElement.clientHeight - menu.offsetHeight - 4)) + 'px'
    menu.tabIndex = -1
    ;(menu.querySelector('button') ?? menu).focus({ preventScroll: true })
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('focusin', outside, true)
    doc.addEventListener('scroll', outside, true)
    return true
  }

  return new Plugin({
    key: spellingKey,
    state: {
      init: (_, state) => check(state.doc, initial),
      apply(transaction, previous) {
        const next = transaction.getMeta(spellingKey)
        if (next) cache = new WeakMap()
        return transaction.docChanged || next ? check(transaction.doc, next ?? previous.checker) : previous
      }
    },
    props: {
      decorations: state => spellingKey.getState(state)?.decorations,
      attributes: { spellcheck: 'false' },
      handleDOMEvents: {
        contextmenu(view, event) {
          const mark = (event.target as Element).closest('.tinto-misspelling')
          if (!mark) return false
          const position = view.posAtDOM(mark, 0)
          if (!showSuggestions(view, position, event.clientX, event.clientY)) return false
          event.preventDefault()
          return true
        }
      },
      handleKeyDown(view, event) {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false
        const position = view.state.selection.head
        const { left, bottom } = view.coordsAtPos(position)
        return showSuggestions(view, position, left, bottom)
      }
    },
    view: () => ({
      update(view, previous) { if (previous.doc !== view.state.doc) dismiss?.() },
      destroy() { dismiss?.() }
    })
  })
}
