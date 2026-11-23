import { group } from './settings'
import { acceptWord, saveWritingPreferences, writingPreferences } from './writing-preferences'
import { button, element, errorMessage, icon } from './ui'

export function writingSettings(panel: HTMLElement, languages: [string, string][]) {
  const checks = group(panel, 'Writing checks')
  panel.prepend(checks)
  const checksStatus = element('p', 'settings-note'); checksStatus.setAttribute('role', 'status')
  for (const [key, text] of [['spelling', 'Check spelling while typing'], ['grammar', 'Check English grammar while typing'], ['style', 'Include style hints (wordiness, long sentences)'], ['coach', 'Writing coach (AI) in Check writing']] as const) {
    const row = element('label', 'field', text), toggle = element('input')
    if (key === 'coach') row.prepend(icon('sparkle'))
    toggle.type = 'checkbox'; toggle.checked = writingPreferences()[key]
    toggle.onchange = () => {
      try {
        const prefs = writingPreferences(); prefs[key] = toggle.checked; saveWritingPreferences(prefs)
        checksStatus.textContent = ''
      } catch (error) {
        toggle.checked = writingPreferences()[key]
        checksStatus.textContent = errorMessage(error)
      }
    }
    row.append(toggle); checks.append(row)
  }
  checks.append(checksStatus, element('p', 'settings-note', 'All start off. Check writing in the document toolbar checks on demand. Suggestions never change your writing unless you apply them. Spelling, grammar and style hints run on this computer.'),
    element('p', 'settings-note', 'The writing coach uses the AI service below. It sends the document or linked section only when you press Check writing.'))
  const dictionary = group(panel, 'Personal dictionary')
  dictionary.append(element('p', 'settings-note', 'Accepted words are remembered across projects on this computer. English and English (UK) share one dictionary.'))
  const languageRow = element('label', 'field', 'Dictionary language'), language = element('select')
  const available = languages.filter(([code]) => code !== 'en-GB')
  for (const [code, label] of available) language.add(new Option(label, code))
  languageRow.append(language); dictionary.append(languageRow)
  const form = element('form', 'personal-word-form'), input = element('input')
  input.type = 'text'; input.required = true; input.maxLength = 100; input.setAttribute('aria-label', 'Word to add'); input.placeholder = 'Word to remember'; input.autocomplete = 'off'
  const add = element('button', 'outline', 'Add word'); add.type = 'submit'
  const status = element('p', 'settings-note'); status.setAttribute('role', 'status')
  const words = element('div', 'personal-words')
  function draw() {
    const accepted = writingPreferences().words[language.value] ?? []
    words.replaceChildren()
    if (!accepted.length) words.append(element('p', 'settings-note', 'No accepted words in this dictionary yet.'))
    for (const word of accepted) {
      const row = element('div', 'personal-word')
      const remove = button('Remove', () => {
        try {
          const prefs = writingPreferences(); prefs.words[language.value] = (prefs.words[language.value] ?? []).filter(item => item !== word)
          saveWritingPreferences(prefs); status.textContent = 'Word removed.'; draw(); input.focus()
        } catch (error) { status.textContent = errorMessage(error) }
      }, 'quiet')
      remove.setAttribute('aria-label', 'Remove ' + word)
      row.append(element('span', '', word), remove); words.append(row)
    }
  }
  form.onsubmit = event => {
    event.preventDefault()
    try { const added = acceptWord(language.value, input.value); input.value = ''; status.textContent = added ? 'Word added.' : 'This word is already in your dictionary.'; draw(); input.focus() }
    catch (error) { status.textContent = errorMessage(error) }
  }
  language.onchange = () => { status.textContent = ''; draw() }
  form.append(input, add); dictionary.append(form, status, words); draw()
  const disabled = group(panel, 'Disabled grammar rules')
  disabled.tabIndex = -1
  const rulesStatus = element('p', 'settings-note'); rulesStatus.setAttribute('role', 'status')
  function drawRules() {
    const title = disabled.firstElementChild!
    disabled.replaceChildren(title, rulesStatus)
    const rules = writingPreferences().disabledRules
    if (!rules.length) disabled.append(element('p', 'settings-note', 'No grammar rules disabled. You can disable an individual rule from a suggestion.'))
    for (const rule of rules) {
      const row = element('div', 'personal-word')
      const restore = button('Restore', () => {
        try {
          const prefs = writingPreferences(); prefs.disabledRules = prefs.disabledRules.filter(item => item !== rule)
          saveWritingPreferences(prefs); rulesStatus.textContent = 'Rule restored.'; drawRules()
          ;(disabled.querySelector('button') ?? disabled).focus({ preventScroll: true })
        } catch (error) { rulesStatus.textContent = errorMessage(error) }
      }, 'quiet')
      restore.setAttribute('aria-label', 'Restore ' + rule.replace(/([a-z])([A-Z])/g, '$1 $2'))
      row.append(element('span', '', rule.replace(/([a-z])([A-Z])/g, '$1 $2')), restore); disabled.append(row)
    }
  }
  drawRules()
}
