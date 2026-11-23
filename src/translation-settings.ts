import type { TranslatorSummary } from './project-types'
import { button, element, errorMessage } from './ui'

// Settings → Writing → AI service: the service, the writer's API key for it and
// the model, used by Translate and the writing coach. The key stays in the main
// process, encrypted with the system keychain. Tinto is tested with OpenAI
// gpt-6.2-astra; other services and models may work, and the writer reviews each
// translation before publishing.
const intro = 'Used by Translate and by the writing coach in Check writing. Tinto sends only the text you choose to translate or review, and asks services that keep responses not to store it. The key is stored encrypted on this computer.'
const tested = 'Tested with OpenAI gpt-6.2-astra. Other services and models may work; review each translation before you publish it.'
// Each service offers a few models to choose from; "Other…" takes any model id.
// Astra is the default and the model Tinto is tested with; the others cost less.
const OPENAI: [string, string][] = [['gpt-6.2-astra', 'GPT-6.2 Astra · tested'], ['gpt-6.2-sol', 'GPT-6.2 Sol · lower cost'], ['gpt-6.1-terra', 'GPT-6.1 Terra · lower cost'], ['gpt-6-luna', 'GPT-6 Luna · lowest cost']]
export const SERVICES: { id: string; name: string; key: string; models: [string, string][] }[] = [
  { id: 'openai', name: 'OpenAI', key: 'OpenAI API key', models: OPENAI },
  { id: 'anthropic', name: 'Anthropic (Claude)', key: 'Anthropic API key', models: [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 · lower cost']] },
  { id: 'openrouter', name: 'OpenRouter', key: 'OpenRouter API key', models: [...OPENAI.map(([id, name]): [string, string] => ['openai/' + id, name]), ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'], ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5 · lower cost']] }
]
const OTHER = 'other'

export function translationSettings(parent: HTMLElement) {
  const api = window.tinto
  const section = element('section', 'translation-settings')
  const body = element('div')
  const message = element('p', '', intro)
  message.setAttribute('role', 'status')
  section.append(element('h3', 'group-label', 'AI service'), body, message, element('p', 'settings-note', tested))
  parent.append(section)

  function busy(task: () => Promise<string>, progress: string) {
    return async () => {
      const controls = () => section.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')
      controls().forEach(el => el.disabled = true)
      message.textContent = progress
      try { message.textContent = await task() } catch (error) { message.textContent = errorMessage(error) }
      finally { controls().forEach(el => el.disabled = false) }
    }
  }
  function draw(saved: TranslatorSummary | null) {
    if (saved) {
      const row = element('div', 'site-row')
      const label = element('div', 'site-label')
      label.append(element('strong', '', saved.name), element('span', 'path', saved.model))
      const test = button('Test', busy(async () => {
        const checked = await api.testTranslator()
        return checked.name + ' accepted the key for ' + checked.model + '.'
      }, 'Checking the key…'), 'outline')
      test.setAttribute('aria-label', 'Test the translation key')
      const remove = button('Remove', busy(async () => {
        await api.removeTranslator()
        draw(null)
        window.dispatchEvent(new Event('tinto-ai-service'))
        return 'Removed the ' + saved.name + ' key from Tinto.'
      }, 'Removing…'), 'outline')
      remove.setAttribute('aria-label', 'Remove the translation key')
      row.append(label, test, remove)
      body.replaceChildren(row)
      return
    }
    const form = element('form', 'translation-form')
    const serviceRow = element('label', 'field', 'Service')
    const service = element('select')
    for (const { id, name } of SERVICES) service.add(new Option(name, id))
    serviceRow.append(service)
    const keyRow = element('label', 'field')
    const keyLabel = document.createTextNode('')
    const key = element('input')
    key.type = 'password'
    key.required = true
    key.autocomplete = 'off'
    key.spellcheck = false
    keyRow.append(keyLabel, key)
    const modelRow = element('label', 'field', 'Model')
    const model = element('select')
    modelRow.append(model)
    const otherRow = element('label', 'field', 'Model id')
    const other = element('input')
    other.autocomplete = 'off'
    other.spellcheck = false
    other.placeholder = 'As the service names it'
    otherRow.append(other)
    const chosenModel = () => model.value === OTHER ? other.value.trim() : model.value
    function showOther() {
      otherRow.hidden = model.value !== OTHER
      other.required = !otherRow.hidden
    }
    model.onchange = showOther
    function choose() {
      const next = SERVICES.find(({ id }) => id === service.value) ?? SERVICES[0]
      keyLabel.textContent = next.key
      model.replaceChildren(...next.models.map(([id, name]) => new Option(name, id)), new Option('Other…', OTHER))
      model.value = next.models[0][0]
      showOther()
    }
    service.onchange = choose
    choose()
    const actions = element('div', 'home-actions')
    const submit = element('button', 'outline', 'Save key')
    submit.type = 'submit'
    actions.append(submit)
    form.append(serviceRow, keyRow, modelRow, otherRow, actions)
    form.onsubmit = event => {
      event.preventDefault()
      void busy(async () => {
        const saved = await api.saveTranslator(service.value, key.value, chosenModel())
        draw(saved)
        window.dispatchEvent(new Event('tinto-ai-service'))
        return 'Saved. Tinto translates and coaches with ' + saved.name + ' ' + saved.model + '.'
      }, 'Checking the key…')()
    }
    body.replaceChildren(form)
  }

  void api.translatorStatus().then(draw).catch(error => { message.textContent = errorMessage(error) })
}
