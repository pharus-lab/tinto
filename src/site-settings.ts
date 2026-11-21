import type { SiteSummary } from './project-types'
import { showSiteGuide } from './site-guide'
import { button, element, errorMessage } from './ui'

const intro = 'Publish to any website that has the Tinto blog module. Copy its publishing URL and API key from the website.'

export function siteSettings(parent: HTMLElement) {
  const api = window.tinto
  const section = element('section', 'site-settings')
  const list = element('div', 'site-list')
  const message = element('p', '', intro)
  message.setAttribute('role', 'status')
  const form = element('form', 'site-form')
  section.append(element('h3', 'group-label', 'Websites'), list, form, message)
  parent.append(section)

  function busy(task: () => Promise<string>, progress: string) {
    return async () => {
      const controls = () => section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
      controls().forEach(el => el.disabled = true)
      message.textContent = progress
      try { message.textContent = await task() } catch (error) { message.textContent = errorMessage(error) }
      finally { controls().forEach(el => el.disabled = false) }
    }
  }
  function draw(sites: SiteSummary[]) {
    list.replaceChildren(...sites.map(site => {
      const row = element('div', 'site-row')
      const label = element('div', 'site-label')
      label.append(element('strong', '', site.name), element('span', 'path', site.endpoint))
      const test = button('Test', busy(async () => {
        const checked = await api.testSite(site.id)
        draw(await api.sites())
        return checked.name + ' accepted the API key.'
      }, 'Checking ' + site.name + '…'), 'outline')
      test.setAttribute('aria-label', 'Test ' + site.name)
      const remove = button('Remove', busy(async () => {
        await api.removeSite(site.id)
        draw(await api.sites())
        return 'Removed ' + site.name + ' and its API key from Tinto. Its posts stay on the website.'
      }, 'Removing ' + site.name + '…'), 'outline')
      remove.setAttribute('aria-label', 'Remove ' + site.name)
      row.append(label, test, remove)
      return row
    }))
  }

  function field(label: string, name: string, type: string) {
    const row = element('label', 'field', label)
    const input = element('input')
    input.type = type
    input.name = name
    input.required = true
    input.autocomplete = 'off'
    input.spellcheck = false
    row.append(input)
    form.append(row)
    return input
  }
  // The ? opens a guide from adding the module to a website through connecting it here.
  const heading = element('div', 'site-form-heading')
  const help = button('', () => showSiteGuide(async site => {
    draw(await api.sites())
    message.textContent = 'Connected ' + site.name + '. The website accepted the API key.'
  }), 'icon-button', 'help')
  help.setAttribute('aria-label', 'How to connect a website')
  help.title = 'How to connect a website'
  heading.append(element('h3', 'group-label', 'Add a website'), help)
  form.append(heading)
  const endpoint = field('Publishing URL', 'endpoint', 'url')
  endpoint.placeholder = 'https://'
  const key = field('API key', 'key', 'password')
  const actions = element('div', 'home-actions')
  const submit = element('button', 'outline', 'Add website')
  submit.type = 'submit'
  actions.append(submit)
  form.append(actions)
  form.onsubmit = event => {
    event.preventDefault()
    void busy(async () => {
      const site = await api.addSite(endpoint.value, key.value)
      form.reset()
      draw(await api.sites())
      return 'Connected ' + site.name + '. The website accepted the API key.'
    }, 'Checking the website…')()
  }

  void api.sites().then(draw).catch(error => { message.textContent = errorMessage(error) })
}
