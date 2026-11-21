import { postFilesEditor } from './post-files-ui'
import type { AuthorshipPreview, CharacterCounts, PostState, PostStatus, SiteSummary } from './project-types'
import { dialogHeader } from './settings'
import { button, element, errorMessage as errorText } from './ui'

export interface PublishTarget { documentId: string; headingId: string | null; title: string; languageName: string }
// The website chosen last is offered first during this session.
let lastSite: string | null = null

export function slugify(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
}

// One line that says where the post stands on this website.
export function postState(post: PostState | null, siteName: string): string {
  if (!post) return 'Not on ' + siteName + ' yet.'
  const when = new Date(post.publishedAt).toLocaleString()
  if (post.status === 'draft') return 'Draft on ' + siteName + ' · saved ' + when + ' · Not public yet'
  return 'Published on ' + siteName + ' · ' + when + ' · ' + (post.url ?? post.slug) + (post.changed ? ' · Changed since the release' : '')
}

// Where the post's characters came from, as the credential will say it.
export function originSummary(characters: CharacterCounts): string {
  const total = characters.written + characters.pasted + characters.imported + characters.ai
  if (!total) return ''
  if (characters.written === total) return 'Original · written in Tinto'
  const share = (count: number, what: string) => count ? Math.max(1, Math.round(count / total * 100)) + '% ' + what : ''
  return [share(characters.written, 'written in Tinto'), share(characters.pasted, 'pasted'), share(characters.imported, 'imported'), share(characters.ai, 'AI-generated')]
    .filter(Boolean).join(' · ')
}
function authorshipLine(authorship: AuthorshipPreview): string {
  const parts = [originSummary(authorship.characters)]
  if (authorship.author) parts.push('signed as ' + authorship.author.name)
  if (!authorship.intact) parts.push('the writing record of this document was altered')
  return parts.filter(Boolean).join(' · ')
}
const unverified = ' The website’s module does not record authorship yet. Update it with Settings → Websites → ? → Save module, then deploy the website.'

export async function showPublish(dialog: HTMLDialogElement, target: PublishTarget, openSettings: () => void, notice: (text: string) => void, showAll: () => void) {
  const api = window.tinto
  const [sites, posts, authorship] = await Promise.all([api.sites(), api.posts(target.documentId, target.headingId), api.authorship(target.documentId, target.headingId)])
  const kind = target.headingId ? 'section' : 'document'
  if (!sites.length) {
    const actions = element('div', 'dialog-actions')
    actions.append(button('Cancel', () => dialog.close(), 'outline'), button('Open Settings', () => { dialog.close(); openSettings() }, 'primary'))
    dialog.replaceChildren(dialogHeader(dialog, 'Publish'), element('p', '', 'Add a website in Settings, then publish this ' + kind + ' as a post.'), actions)
    if (!dialog.open) dialog.showModal()
    return
  }
  const records = new Map(posts.map(post => [post.siteId, post]))

  function render(site: SiteSummary) {
    lastSite = site.id
    const post = records.get(site.id) ?? null
    // A post on another website supplies the text fields; files are chosen per website.
    const known = post ?? posts[0] ?? null
    const form = element('form', 'publish-form')
    function select(label: string, options: [string, string][], value: string) {
      const row = element('label', 'field', label)
      const input = element('select')
      input.setAttribute('aria-label', label)
      for (const [id, text] of options) input.add(new Option(text, id))
      input.value = value
      row.append(input)
      form.append(row)
      return input
    }
    const picker = select('Website', sites.map(item => [item.id, item.name + (records.has(item.id) ? ' · ' + (records.get(item.id)!.status === 'draft' ? 'draft' : 'published') : '')]), site.id)
    picker.onchange = () => render(sites.find(item => item.id === picker.value) ?? site)
    function field(label: string, value: string, type = 'text') {
      const row = element('label', 'field', label)
      const input = element('input')
      input.type = type
      input.value = value
      row.append(input)
      form.append(row)
      return input
    }
    const title = field('Title', known?.title ?? target.title)
    title.required = true
    title.maxLength = 200
    const slug = field('Address', known?.slug ?? slugify(target.title))
    slug.required = true
    slug.maxLength = 100
    slug.spellcheck = false
    let slugEdited = !!known
    slug.oninput = () => { slugEdited = true }
    title.oninput = () => { if (!slugEdited) slug.value = slugify(title.value) }
    // Categories come from the website, so each site offers its own sections or pages.
    const categories = site.categories
    const category = categories.length
      ? select('Category', categories.map(item => [item.id, item.label]), categories.some(item => item.id === known?.category) ? known!.category : categories[0].id)
      : null
    const date = field('Date', known?.date ?? new Date().toLocaleDateString('en-CA'), 'date')
    date.required = true
    const summaryRow = element('label', 'field stacked', 'Summary')
    const summary = element('textarea')
    summary.rows = 3
    summary.maxLength = 500
    summary.value = known?.summary ?? ''
    summaryRow.append(summary)
    form.append(summaryRow)
    const tags = field('Tags', (known?.tags ?? []).join(', '))
    tags.placeholder = 'Separated by commas'
    form.append(element('p', '', 'Language · ' + target.languageName))
    // Every post is signed. The first time, Tinto asks whose name to sign with.
    const signer = authorship.author ? null : field('Sign as', '')
    if (signer) {
      signer.required = true
      signer.maxLength = 100
      signer.autocomplete = 'name'
      signer.placeholder = 'Your name as the author'
    }
    const origins = element('p', 'publish-authorship', authorshipLine(authorship))
    form.append(origins)
    async function ensureAuthor() {
      if (!signer || authorship.author) return
      authorship.author = await api.createAuthor(signer.value)
      signer.closest('.field')?.remove()
      origins.textContent = authorshipLine(authorship)
    }

    const status = element('p', 'publish-status')
    status.setAttribute('role', 'status')
    status.textContent = postState(post, site.name)
    const files = postFilesEditor(post, text => { status.textContent = text })
    form.append(files.element)
    const actions = element('div', 'dialog-actions')
    form.append(status, actions)
    const controls = () => form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button, input, textarea, select')
    function run<T>(task: () => Promise<T>, progress: string, done: (result: T) => string) {
      return async () => {
        controls().forEach(el => el.disabled = true)
        status.textContent = progress
        const stop = api.onPublishProgress((sent, total) => { status.textContent = 'Uploading ' + sent + ' of ' + total + ' files…' + (sent === total ? ' Sending the post…' : '') })
        try {
          const result = await task()
          dialog.close()
          notice(done(result))
        } catch (error) {
          controls().forEach(el => el.disabled = false)
          status.textContent = errorText(error)
        } finally { stop() }
      }
    }
    const request = (state: PostStatus) => ({
      siteId: site.id, documentId: target.documentId, headingId: target.headingId, status: state,
      fields: {
        title: title.value, slug: slug.value, summary: summary.value, date: date.value, category: category?.value ?? '',
        tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean)
      },
      ...files.values()
    })
    // The preview opens in the browser; the dialog stays open to keep editing.
    async function preview() {
      if (!form.reportValidity()) return
      controls().forEach(el => el.disabled = true)
      status.textContent = 'Preparing the preview…'
      const stop = api.onPublishProgress((sent, total) => { status.textContent = 'Uploading ' + sent + ' of ' + total + ' files for the preview…' })
      try {
        await ensureAuthor()
        await api.previewPost(request('draft'))
        status.textContent = 'Opened the preview of ' + site.name + ' in your browser. The link works for one hour.'
      } catch (error) { status.textContent = errorText(error) }
      finally {
        stop()
        controls().forEach(el => el.disabled = false)
      }
    }
    function send(state: PostStatus) {
      return run(async () => { await ensureAuthor(); return api.publishPost(request(state)) }, 'Preparing the post…', sent => (state === 'draft'
        ? 'Saved “' + title.value.trim() + '” as a draft on ' + site.name + '.'
        : 'Published “' + title.value.trim() + '” on ' + site.name + '.') + (sent.verified ? '' : unverified))
    }
    function drawActions() {
      actions.replaceChildren(button('All posts', () => { dialog.close(); showAll() }, 'outline publish-all'))
      if (post) actions.append(button('Unpublish', () => {
        status.textContent = 'Remove this post from ' + site.name + '? The ' + kind + ' stays in Tinto.'
        actions.replaceChildren(
          button('Keep post', () => { status.textContent = postState(post, site.name); drawActions() }, 'outline'),
          button('Remove from site', run(() => api.unpublishPost(site.id, target.documentId, target.headingId), 'Removing the post…', () => 'Removed “' + post.title + '” from ' + site.name + '.'), 'primary')
        )
      }, 'outline'))
      // A draft goes to the website with its files but stays out of its pages.
      const draft = button(post?.status === 'published' ? 'Move to drafts' : post ? 'Update draft' : 'Save draft', () => {
        if (form.reportValidity()) void send('draft')()
      }, 'outline')
      const submit = element('button', 'primary', post?.status === 'published' ? 'Update post' : 'Publish')
      submit.type = 'submit'
      actions.append(button('Cancel', () => dialog.close(), 'outline'), button('Preview', () => void preview(), 'outline'), draft, submit)
    }
    drawActions()
    form.onsubmit = event => {
      event.preventDefault()
      void send('published')()
    }
    dialog.replaceChildren(dialogHeader(dialog, post?.status === 'published' ? 'Update post' : 'Publish'), form)
    if (!dialog.open) dialog.showModal()
  }
  render(sites.find(item => item.id === lastSite) ?? sites.find(item => records.has(item.id)) ?? sites[0])
}
