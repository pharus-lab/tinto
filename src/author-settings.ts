import type { AuthorSummary } from './project-types'
import { button, element, errorMessage } from './ui'

// The author key signs every post. It stays on this computer; an export, locked
// with a passphrase, carries it to another one.
const intro = 'Tinto signs every post with an author key kept on this computer, so your websites can show that you wrote it.'
export const shortDid = (did: string) => did.slice(0, 14) + '…' + did.slice(-6)

export function authorSettings(parent: HTMLElement) {
  const api = window.tinto
  const section = element('section', 'author-settings')
  const body = element('div')
  const message = element('p', '', intro)
  message.setAttribute('role', 'status')
  section.append(element('h3', 'group-label', 'Author'), body, message)
  parent.append(section)

  function busy(task: () => Promise<string | null>, progress: string) {
    return async () => {
      const controls = () => section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
      controls().forEach(el => el.disabled = true)
      message.textContent = progress
      try { message.textContent = await task() ?? intro } catch (error) { message.textContent = errorMessage(error) }
      finally { controls().forEach(el => el.disabled = false) }
    }
  }
  function field(form: HTMLElement, label: string, type: string, value = '') {
    const row = element('label', 'field', label)
    const input = element('input')
    input.type = type
    input.value = value
    input.required = true
    input.spellcheck = false
    row.append(input)
    form.append(row)
    return input
  }
  // Export and import both ask for the passphrase in place, then run.
  function withPassphrase(action: 'export' | 'import', author: AuthorSummary | null) {
    const form = element('form', 'author-form')
    const passphrase = field(form, 'Passphrase', 'password')
    passphrase.minLength = 12
    passphrase.autocomplete = action === 'export' ? 'new-password' : 'current-password'
    const actions = element('div', 'home-actions')
    const submit = element('button', 'primary', action === 'export' ? 'Export key' : 'Import key')
    submit.type = 'submit'
    actions.append(submit, button('Cancel', () => draw(author), 'outline'))
    form.append(actions)
    form.onsubmit = event => {
      event.preventDefault()
      void busy(async () => {
        if (action === 'export') {
          const path = await api.exportAuthor(passphrase.value)
          draw(author)
          return path ? 'Exported your author key to ' + path + '. Keep the file and its passphrase somewhere safe.' : null
        }
        const imported = await api.importAuthor(passphrase.value)
        if (!imported) return null
        draw(imported)
        return 'This computer now signs as ' + imported.name + '.'
      }, action === 'export' ? 'Encrypting the key…' : 'Opening the key file…')()
    }
    body.replaceChildren(form)
    message.textContent = action === 'export'
      ? 'Choose a passphrase of at least 12 characters. You need it to import the key on another computer.'
      : 'Enter the passphrase of the key file, then choose the file.'
    passphrase.focus()
  }
  function draw(author: AuthorSummary | null) {
    const form = element('form', 'author-form')
    const name = field(form, author ? 'Name' : 'Your name', 'text', author?.name ?? '')
    name.maxLength = 100
    name.autocomplete = 'name'
    const actions = element('div', 'home-actions')
    const submit = element('button', 'outline', author ? 'Save name' : 'Create author key')
    submit.type = 'submit'
    actions.append(submit)
    form.append(actions)
    // Saving is offered once the name differs from the one posts are signed with.
    if (author) {
      submit.disabled = true
      name.oninput = () => { submit.disabled = name.value.trim() === author.name || !name.value.trim() }
    }
    form.onsubmit = event => {
      event.preventDefault()
      void busy(async () => {
        const saved = author ? await api.renameAuthor(name.value) : await api.createAuthor(name.value)
        draw(saved)
        return author ? 'Your next posts are signed as ' + saved.name + '.' : 'Created your author key. Your posts are signed as ' + saved.name + '.'
      }, author ? 'Saving…' : 'Creating your author key…')()
    }
    body.replaceChildren(form)
    if (!author) {
      actions.append(button('Import key…', () => withPassphrase('import', null), 'outline'))
      return
    }
    // The did:key is how websites and verifiers name this author.
    const key = element('div', 'site-row')
    const label = element('div', 'site-label')
    label.append(element('strong', '', 'Author key'), element('span', 'path', shortDid(author.did)))
    label.title = author.did
    const copy = button('Copy', () => void api.copyText(author.did).then(() => { message.textContent = 'Copied your author key. Websites use it in tinto.config.mjs as author.' }), 'outline')
    copy.setAttribute('aria-label', 'Copy author key')
    key.append(label, copy)
    const more = element('div', 'home-actions')
    more.append(button('Export key…', () => withPassphrase('export', author), 'outline'), button('Import key…', () => withPassphrase('import', author), 'outline'))
    body.append(key, more)
  }

  void api.author().then(draw).catch(error => { message.textContent = errorMessage(error) })
}
