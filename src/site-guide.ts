import { PROTOCOL } from '../modules/cloudflare/shared.mjs'
import type { SiteSummary } from './project-types'
import { dialogHeader } from './settings'
import { button, element, errorMessage } from './ui'

// A step-by-step guide that connects a website on Cloudflare Workers: Tinto
// writes the blog module into the site, a coding agent wires it, and the writer
// adds the key and connects. Opened from Settings → Websites → ?.

export interface GuideValues { name: string; site: string; folder: string | null; key: string }
const BASE_PATH = '/api/tinto'
export const publishingURL = (site: string) => site.replace(/\/+$/, '') + BASE_PATH

export function connectPrompt(values: GuideValues): string {
  const where = values.folder ? 'Tinto saved the module in ' + values.folder + '/tinto.' : 'The module is in the tinto/ folder of this project.'
  return `Connect the Tinto blog module to this website, so the Tinto writing app can publish posts to it.

${where} Follow the "For coding agents" section of tinto/README.md. In short:
1. Confirm that the site deploys to Cloudflare Workers (wrangler.jsonc, wrangler.json or wrangler.toml). If it does not, stop and tell me.
2. In tinto/tinto.config.mjs, name is ${JSON.stringify(values.name)} and site is ${JSON.stringify(values.site)}. Set languages and postPath only if the site's routes need them. Leave author as it is: it is my author key. Do not change the other files in tinto/.
3. Add the storage bindings without IDs, so Wrangler (4.45 or later) creates them on the next deploy:
   "d1_databases": [{ "binding": "TINTO_DB" }]
   "r2_buckets": [{ "binding": "TINTO_MEDIA" }]
4. In the Worker's fetch, after any redirect to the canonical host and before static assets, return the response of await tinto.fetch(request, env, ctx) when it is not null. A site with only static assets needs the small Worker described in the README.
5. Make the posts available to pages: the Astro loader in tinto/astro.mjs, or the feed at ${values.site}${BASE_PATH}/feed for other frameworks.
6. Do not create secrets, deploy, commit or push. I will add TINTO_API_KEY and TINTO_DEPLOY_HOOK myself.
7. Run the site's build and tests. Then tell me what you changed and anything I must do by hand. The publishing URL will be ${publishingURL(values.site)}.`
}

export function pagesPrompt(values: GuideValues): string {
  return `Show the posts that Tinto publishes on this website (${values.site}), in the site's own design. Follow "Showing posts in the site's design" in tinto/README.md:
- Add a post list and a post page that reuse the site's existing layout, components, typography and styles. Do not add a new visual style.
- Render post.html as HTML (only p, h1–h6, strong, em and u without attributes, plus mark, which older posts use for the same underline). Render the title, summary and tags as text.
- Show the cover and images with their alt text, and list post.attachments by their title with a link to their url (use the download attribute for ZIP and CSV, and audio or video elements for media). All urls are on this site.
- If the site has categories, use post.category to place each post on the right page or section.
- Show the authorship line quietly near the title or date, styled like the site's other small metadata: authorshipLabel(post.authorship, post.language) from tinto/credential.mjs (for example "Original · written by …", or the Spanish line for Spanish posts, or "Automatic translation from Spanish · reviewed by …" for an automatic translation). Never hide it when the post includes AI-generated text. Next to it, show authorshipDetails(post.authorship, post.language) in a <details> element styled like the site (its summary opens the rows, notes and the download link in place, with no script).
- Add the preview page from "Preview page" in tinto/README.md at previewPath (/tinto-preview): the same post layout with %%title%%, %%authorship%%, %%body%% and the other markers, kept out of the sitemap and with noindex.
- Follow the site's language routes, and set postPath in tinto/tinto.config.mjs to match the post page.
Do not deploy, commit or push. Run the build and tests and show me the result.`
}

// 32 random bytes in base64url: 43 characters that need no quoting in a shell.
export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const steps = ['Your site', 'Add the module', 'Connect it with your agent', 'Key and deploy', 'Connect Tinto']

export function showSiteGuide(onConnected: (site: SiteSummary) => void) {
  const api = window.tinto
  const values: GuideValues = { name: '', site: '', folder: null, key: '' }
  const dialog = element('dialog', 'guide')
  dialog.setAttribute('aria-labelledby', 'guide-title')
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  let step = 0
  let connected: SiteSummary | null = null
  // A step can check its fields before the guide moves on.
  let beforeNext: (() => void) | null = null

  const status = element('p', 'guide-status')
  status.setAttribute('role', 'status')
  const say = (text: string) => { status.textContent = text }
  function copyButton(label: string, text: () => string) {
    const copy = button('Copy', () => void api.copyText(text()).then(() => say(label + ' copied.')).catch(error => say(errorMessage(error))), 'outline')
    copy.setAttribute('aria-label', 'Copy ' + label)
    return copy
  }
  function block(label: string, text: string) {
    const wrap = element('div', 'guide-block')
    const pre = element('pre', 'guide-prompt', text)
    pre.tabIndex = 0
    pre.setAttribute('aria-label', label)
    wrap.append(pre, copyButton(label, () => text))
    return wrap
  }
  function command(label: string, text: string) {
    const row = element('div', 'guide-command')
    row.append(element('code', '', text), copyButton(label, () => text))
    return row
  }
  function field(label: string, value: string, type = 'text') {
    const row = element('label', 'field', label)
    const input = element('input')
    input.type = type
    input.value = value
    input.spellcheck = false
    input.autocomplete = 'off'
    row.append(input)
    return { row, input }
  }

  function site(body: HTMLElement) {
    body.append(element('p', '', 'Tinto publishes to websites that include the Tinto blog module. This guide adds the module to a website on Cloudflare Workers, then connects it to Tinto.'))
    const needs = element('ul', 'guide-list')
    needs.append(
      element('li', '', 'A website that deploys to Cloudflare Workers. Its project folder has wrangler.jsonc, wrangler.json or wrangler.toml.'),
      element('li', '', 'The website’s code on this computer, and a coding agent such as Claude Code.'),
      element('li', '', 'Node.js, to run two Wrangler commands.')
    )
    const name = field('Site name', values.name)
    name.input.placeholder = 'My blog'
    const address = field('Site address', values.site, 'url')
    address.input.placeholder = 'https://example.com'
    body.append(element('h3', 'group-label', 'You need'), needs, element('h3', 'group-label', 'Your website'), name.row, address.row)
    beforeNext = () => {
      const label = name.input.value.trim()
      let url: URL | null = null
      try { url = new URL(address.input.value.trim()) } catch { /* Reported below. */ }
      if (!label || label.length > 80) throw Error('Give the website a name of up to 80 characters.')
      if (!url || !/^https?:$/.test(url.protocol)) throw Error('Enter the website address, such as https://example.com.')
      values.name = label
      values.site = url.origin
    }
  }

  function addModule(body: HTMLElement) {
    body.append(
      element('p', '', 'Tinto writes the module into a tinto folder inside your website’s project, with the name and address already filled in.'),
      element('p', '', 'To update the module later, save it to the same folder again. The code is replaced and your tinto.config.mjs is kept.')
    )
    const result = element('p', 'path')
    if (values.folder) result.textContent = 'Saved in ' + values.folder + '/tinto.'
    const save = button('Save module to your site…', () => void (async () => {
      try {
        const saved = await api.saveModule({ name: values.name, site: values.site })
        if (!saved) return
        values.folder = saved.path.replace(/[\\/]tinto$/, '')
        result.textContent = (saved.updated ? 'Updated the module in ' + saved.path + '. Your tinto.config.mjs was kept.' : 'Saved in ' + saved.path + '.')
        say('')
      } catch (error) { say(errorMessage(error)) }
    })(), 'primary')
    const actions = element('div', 'home-actions')
    actions.append(save)
    body.append(actions, result)
  }

  function agent(body: HTMLElement) {
    body.append(
      element('p', '', 'Open your coding agent in the website’s folder and give it this prompt. It adds the storage, routes the module’s addresses through your Worker and makes posts available to your pages. It does not deploy anything.'),
      block('Connect prompt', connectPrompt(values)),
      element('h3', 'group-label', 'Optional: show posts in your design'),
      element('p', '', 'If the site has no pages for posts yet, this prompt asks the agent to build them with your existing layout and styles.'),
      block('Design prompt', pagesPrompt(values))
    )
  }

  function key(body: HTMLElement) {
    if (!values.key) values.key = newKey()
    const keyField = field('API key', values.key)
    keyField.input.readOnly = true
    keyField.input.className = 'guide-key'
    const keyRow = element('div', 'guide-command')
    keyRow.append(keyField.row, copyButton('API key', () => values.key), button('New key', () => { values.key = newKey(); keyField.input.value = values.key; say('Created a new key. Store it in Cloudflare again.') }, 'outline'))
    const dashboard = button('Open Cloudflare dashboard', () => void api.openCloudflare().catch(error => say(errorMessage(error))), 'outline')
    const dashboardRow = element('div', 'home-actions')
    dashboardRow.append(dashboard)
    body.append(
      element('h3', 'group-label', '1. Store the API key'),
      element('p', '', 'Tinto created this key and keeps it for the last step. Run the command in the website’s folder and paste the key when Wrangler asks for it.'),
      keyRow,
      command('Key command', 'npx wrangler secret put TINTO_API_KEY'),
      element('h3', 'group-label', '2. Rebuild after each post (sites built ahead of time)'),
      element('p', '', 'Most Astro and other static sites need this. In the Cloudflare dashboard, open your Worker, then Settings → Builds → Deploy Hooks, and create a hook for your production branch. Copy its URL and store it with this command. Skip this if your pages are rendered on each request.'),
      dashboardRow,
      command('Hook command', 'npx wrangler secret put TINTO_DEPLOY_HOOK'),
      element('h3', 'group-label', '3. Deploy'),
      element('p', '', 'Deploy the website with your agent’s changes: push them to your production branch, or run npx wrangler deploy. The first deploy creates the database and the file bucket.'),
      element('p', '', 'Once the module is live, this address answers with "tinto": ' + PROTOCOL + '.'),
      command('Feed address', values.site + BASE_PATH + '/feed')
    )
  }

  function connect(body: HTMLElement) {
    const url = field('Publishing URL', publishingURL(values.site), 'url')
    const secret = field('API key', values.key, 'password')
    const done = element('p', 'path')
    const go = button('Connect website', () => void (async () => {
      go.disabled = true
      say('Checking the website…')
      try {
        connected = await api.addSite(url.input.value, secret.input.value)
        onConnected(connected)
        done.textContent = 'Connected ' + connected.name + '. Use Publish to send a document or section to it.'
        say('')
        render()
      } catch (error) { say(errorMessage(error)) }
      finally { go.disabled = false }
    })(), 'primary')
    const actions = element('div', 'home-actions')
    actions.append(go)
    const fixes = element('ul', 'guide-list')
    fixes.append(
      element('li', '', 'No Tinto blog module at this URL: deploy the website first, then check the address.'),
      element('li', '', 'Rejected the API key: run the key command again with the key above.'),
      element('li', '', 'No Tinto API key yet: the TINTO_API_KEY secret is missing.'),
      element('li', '', 'Add the TINTO_DB and TINTO_MEDIA bindings: the agent’s Wrangler changes are not deployed yet.'),
      element('li', '', 'Could not reach the website, or a redirect: use the final address, for example without www if the site redirects.')
    )
    if (connected) done.textContent = 'Connected ' + connected.name + '. Use Publish to send a document or section to it.'
    body.append(element('p', '', 'Tinto checks the address and the key before saving them.'), url.row, secret.row, actions, done, element('h3', 'group-label', 'If it fails'), fixes)
  }

  const pages = [site, addModule, agent, key, connect]
  function render() {
    const head = dialogHeader(dialog, 'Connect a website')
    head.querySelector('h2')!.id = 'guide-title'
    const nav = element('ol', 'guide-steps')
    steps.forEach((title, index) => {
      const item = element('li', index === step ? 'current' : index < step ? 'done' : '', title)
      if (index === step) item.setAttribute('aria-current', 'step')
      nav.append(item)
    })
    const body = element('div', 'guide-body')
    body.append(element('h3', 'guide-heading', (step + 1) + '. ' + steps[step]))
    beforeNext = null
    pages[step](body)
    const actions = element('div', 'dialog-actions')
    if (step > 0) actions.append(button('Back', () => { step--; say(''); render() }, 'outline'))
    if (step < pages.length - 1) actions.append(button('Next', () => {
      try { beforeNext?.(); step++; say(''); render() }
      catch (error) { say(errorMessage(error)) }
    }, 'primary'))
    else actions.append(button(connected ? 'Done' : 'Close', () => dialog.close(), connected ? 'primary' : 'outline'))
    dialog.replaceChildren(head, nav, body, status, actions)
  }
  render()
  dialog.showModal()
}
