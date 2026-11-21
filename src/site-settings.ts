import type { SiteConfig } from './cloudflare'
import { button, element, errorMessage } from './ui'

const fields: [keyof SiteConfig, string, string][] = [
  ['accountId', 'Account ID', 'text'],
  ['databaseId', 'D1 database ID', 'text'],
  ['bucket', 'R2 bucket', 'text'],
  ['token', 'API token', 'password'],
  ['deployHook', 'Deploy Hook URL', 'password']
]

export function siteSettings(parent: HTMLElement) {
  const section = element('section', 'site-settings')
  section.append(element('h3', 'group-label', 'Cloudflare site'))
  const body = element('div')
  const message = element('p')
  message.setAttribute('role', 'status')
  section.append(body, message)
  parent.append(section)
  function failure(error: unknown) { message.textContent = errorMessage(error) }
  function busy(task: () => Promise<void>, progress: string) {
    return async () => {
      section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(el => el.disabled = true)
      message.textContent = progress
      try { await task() } catch (error) { failure(error) }
      finally { section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(el => el.disabled = false) }
    }
  }
  async function refresh(note = '') {
    const api = window.tinto
    const state = await api.siteStatus()
    body.replaceChildren()
    if (!state.connected) {
      const form = element('form', 'site-form')
      const inputs = new Map<keyof SiteConfig, HTMLInputElement>()
      for (const [name, label, type] of fields) {
        const row = element('label', 'field', label)
        const input = element('input')
        input.type = type
        input.name = name
        input.required = true
        input.autocomplete = 'off'
        input.spellcheck = false
        row.append(input)
        inputs.set(name, input)
        form.append(row)
      }
      const actions = element('div', 'home-actions')
      const submit = element('button', 'outline', 'Connect site')
      submit.type = 'submit'
      actions.append(submit)
      form.append(actions)
      form.onsubmit = event => {
        event.preventDefault()
        const config = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])) as unknown as SiteConfig
        void busy(async () => {
          await api.connectSite(config)
          await refresh('Connected. Tinto checked the D1 table and wrote and removed a test file in the bucket.')
        }, 'Checking D1 and R2…')()
      }
      body.append(form)
      message.textContent = note || 'Publish posts to D1 and their images to R2, then start a Workers Builds deploy hook. The token needs D1 Edit and Workers R2 Storage Bucket Item Write on the bucket.'
      return
    }
    if (state.accountId) body.append(element('p', 'path', 'Bucket ' + state.bucket + ' · D1 ' + state.databaseId + ' · Account ' + state.accountId))
    message.textContent = state.error ?? note
    const actions = element('div', 'home-actions')
    actions.append(
      button('Test connection', busy(async () => { await api.testSite(); await refresh('D1 and R2 accepted the token.') }, 'Checking D1 and R2…'), 'outline'),
      button('Disconnect site', busy(async () => { await api.disconnectSite(); await refresh('Disconnected. The token and deploy hook were removed from this computer.') }, 'Disconnecting…'), 'outline')
    )
    body.append(actions)
  }
  void refresh().catch(failure)
}
