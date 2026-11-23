import { visibleText } from './model'
import type { DocumentRecord, DocumentTranslation } from './project-types'
import { dialogHeader } from './settings'
import { translatedManuscript, translationSource } from './translation'
import { button, element, errorMessage, icon } from './ui'

// Translate: a document becomes a new document in another language, marked as
// an automatic translation. Translating again replaces the text of that
// translation; its previous text stays in History.
export interface TranslateContext {
  doc: DocumentRecord
  documents: DocumentRecord[]
  languages: [string, string][]
  flush(): boolean
  create(doc: DocumentRecord): string | null
  replace(doc: DocumentRecord): string | null
  record(documentId: string, characters: number): void
  open(id: string): void
  openSettings(): void
  notice(text: string): void
}

export const languageName = (code: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code }
}
const words = (doc: DocumentRecord) => visibleText(doc.manuscript).split(/\s+/).filter(Boolean).length
export const translationOf = (documents: DocumentRecord[], original: DocumentRecord, language: string) =>
  documents.find(doc => doc.translation?.of === original.id && doc.language === language) ?? null

export async function showTranslate(dialog: HTMLDialogElement, ctx: TranslateContext) {
  const api = window.tinto
  const translator = await api.translatorStatus()
  const again = !!ctx.doc.translation
  const head = dialogHeader(dialog, again ? 'Translate again' : 'Translate')
  const actions = element('div', 'dialog-actions')
  const show = (...children: HTMLElement[]) => {
    dialog.replaceChildren(head, ...children, actions)
    if (!dialog.open) dialog.showModal()
  }
  if (!translator) {
    actions.append(button('Cancel', () => dialog.close(), 'outline'), button('Open Settings', () => { dialog.close(); ctx.openSettings() }, 'primary'))
    return show(element('p', '', 'Add an API key from OpenAI, Anthropic or OpenRouter in Settings → Writing → Automatic translation, then translate.'))
  }
  // A translation is translated again from its original.
  const original = again ? ctx.documents.find(doc => doc.id === ctx.doc.translation!.of) ?? null : ctx.doc
  if (!original) {
    actions.append(button('Close', () => dialog.close(), 'primary'))
    return show(element('p', '', 'The original of this translation is no longer in this project, so it cannot be translated again.'))
  }
  const body = element('div', 'translate-body')
  const message = element('p', 'translate-status')
  message.setAttribute('role', 'status')
  let select: HTMLSelectElement | null = null
  if (again) {
    body.append(element('p', '', 'Tinto translates “' + original.title + '” again and replaces the text of this translation. Its current text stays in History.'))
  } else {
    const options = ctx.languages.filter(([code]) => code !== original.language)
    if (!options.length) {
      actions.append(button('Close', () => dialog.close(), 'primary'))
      return show(element('p', '', 'Add another language in Settings → Writing → Spelling to translate into it.'))
    }
    const preferred = original.language.startsWith('es') ? 'en' : original.language.startsWith('en') ? 'es' : options[0][0]
    const row = element('label', 'field', 'Into')
    select = element('select')
    for (const [code, name] of options) select.add(new Option(name, code))
    select.value = options.some(([code]) => code === preferred) ? preferred : options[0][0]
    select.onchange = drawActions
    row.append(select)
    body.append(element('p', '', '“' + original.title + '” · ' + languageName(original.language) + ' · ' + words(original).toLocaleString('en') + ' words'), row)
  }
  body.append(element('p', 'translate-note', 'Tinto sends the chosen wording of the whole document to ' + translator.name + ' (' + translator.model + ')' + (translator.provider === 'anthropic' ? '' : ' and asks it not to store it') + '. The translation is marked as automatic; the words you change become yours.'))

  function drawActions() {
    const code = select?.value ?? ctx.doc.language
    const found = again ? ctx.doc : translationOf(ctx.documents, original!, code)
    actions.replaceChildren(button('Cancel', () => dialog.close(), 'outline'))
    if (found && !again) actions.append(button('Open translation', () => { dialog.close(); ctx.open(found.id) }, 'outline'))
    actions.append(button(found ? 'Translate again' : 'Translate', () => void run(code, found), 'primary'))
  }
  async function run(code: string, found: DocumentRecord | null) {
    if (!ctx.flush()) return
    const controls = dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')
    controls.forEach(control => control.disabled = true)
    message.textContent = 'Translating…'
    const stop = api.onTranslateProgress((done, total) => {
      if (total > 1 && done < total) message.textContent = 'Translating part ' + (done + 1) + ' of ' + total + '…'
    })
    try {
      const source = translationSource(original!.manuscript, original!.title)
      if (!source.blocks.length) throw Error('Write some text before translating.')
      const result = await api.translate(source, original!.language, code)
      const manuscript = translatedManuscript(original!.manuscript, source, result)
      const translation: DocumentTranslation = { of: original!.id, from: original!.language, provider: translator!.name, model: translator!.model, at: Date.now() }
      let id: string
      if (found) {
        await api.nameVersion(found.id, 'Before translating again')
        const problem = ctx.replace({ ...found, title: result.title, manuscript, translation })
        if (problem) throw Error(problem)
        id = found.id
      } else {
        id = crypto.randomUUID()
        const problem = ctx.create({ id, title: result.title, language: code, manuscript, translation })
        if (problem) throw Error(problem)
      }
      ctx.record(id, [...manuscript.content.map(visibleText).join('')].length)
      dialog.close()
      ctx.open(id)
      ctx.notice('Translated “' + original!.title + '” into ' + languageName(code) + '. Review it before you publish it.')
    } catch (error) {
      message.textContent = errorMessage(error)
      controls.forEach(control => control.disabled = false)
    } finally { stop() }
  }
  drawActions()
  show(body, message)
}

// Above a translation's text: what it is, and the way back to its original.
export function drawTranslationNote(note: HTMLElement, doc: DocumentRecord | null, documents: DocumentRecord[], actions: { open(id: string): void; again(): void }) {
  const translation = doc?.translation
  document.body.classList.toggle('translation-doc', !!translation)
  note.hidden = !translation
  if (!translation) return void note.replaceChildren()
  const original = documents.find(item => item.id === translation.of)
  const text = element('p', '', 'Automatic translation from ' + languageName(translation.from) + ' · ' + (translation.provider ?? 'OpenAI') + ' ' + translation.model + '. The words you change are marked as yours.')
  const buttons = element('div', 'translation-note-actions')
  if (original) buttons.append(button('Open original', () => actions.open(original.id)))
  buttons.append(button('Translate again', actions.again))
  note.replaceChildren(icon('globe'), text, buttons)
}
