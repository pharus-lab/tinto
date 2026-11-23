import { postFilesEditor } from './post-files-ui'
import type { AuthorshipPreview, CharacterCounts, PostState, PostStatus, PublishPair, PublishRequest, SiteSummary } from './project-types'
import { dialogHeader } from './settings'
import { button, element, errorMessage as errorText } from './ui'

export interface PublishTarget {
  documentId: string; headingId: string | null; title: string; language: string; languageName: string
  // A document that is an automatic translation says from which language.
  translationFrom?: string
  // The original or the translation that can be published with this document.
  partner?: { documentId: string; title: string; language: string; languageName: string; kind: 'translation' | 'original' }
}
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
  const [sites, posts, authorship, partnerPosts] = await Promise.all([
    api.sites(), api.posts(target.documentId, target.headingId), api.authorship(target.documentId, target.headingId),
    target.partner && !target.headingId ? api.posts(target.partner.documentId, null) : Promise.resolve([])
  ])
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
    // A translation and its original share one address: the one already
    // published, else one made from the original's title.
    const partnerKnown = target.partner && !target.headingId ? partnerPosts.find(item => item.siteId === site.id) ?? partnerPosts[0] ?? null : null
    const slugFrom = target.partner?.kind === 'original' && !target.headingId ? target.partner.title : null
    const slug = field('Address', known?.slug ?? partnerKnown?.slug ?? slugify(slugFrom ?? target.title))
    slug.required = true
    slug.maxLength = 100
    slug.spellcheck = false
    let slugEdited = !!known || !!partnerKnown || !!slugFrom
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
    // A whole document and its automatic translation go out together at the same
    // address, so the website links them as translations of each other.
    let pair: { include: HTMLInputElement; title: HTMLInputElement; summary: HTMLTextAreaElement } | null = null
    const partner = target.headingId ? null : target.partner
    if (partner) {
      const known = partnerKnown
      const includeRow = element('label', 'field publish-pair', 'Also publish the ' + partner.languageName + ' ' + partner.kind)
      const include = element('input')
      include.type = 'checkbox'
      include.checked = true
      includeRow.append(include)
      const fields = element('div', 'publish-pair-fields')
      const titleRow = element('label', 'field', 'Title (' + partner.languageName + ')')
      const pairTitle = element('input')
      pairTitle.required = true
      pairTitle.maxLength = 200
      pairTitle.value = known?.title ?? partner.title
      titleRow.append(pairTitle)
      const summaryRow = element('label', 'field stacked', 'Summary (' + partner.languageName + ')')
      const pairSummary = element('textarea')
      pairSummary.rows = 3
      pairSummary.maxLength = 500
      pairSummary.value = known?.summary ?? ''
      summaryRow.append(pairSummary)
      const translateRow = element('div', 'field-actions')
      const translateSummary = button('Translate summary', async () => {
        if (!summary.value.trim()) { status.textContent = 'Write the summary first, then translate it.'; return }
        translateSummary.disabled = true
        status.textContent = 'Translating the summary…'
        try {
          pairSummary.value = (await api.translateTexts([summary.value], target.language, partner.language))[0]
          status.textContent = 'Translated the summary. Review it before you publish.'
        } catch (error) { status.textContent = errorText(error) }
        finally { translateSummary.disabled = false }
      }, 'outline')
      translateRow.append(translateSummary)
      fields.append(titleRow, summaryRow, translateRow)
      include.onchange = () => { fields.hidden = !include.checked; pairTitle.required = include.checked }
      form.append(includeRow, fields)
      pair = { include, title: pairTitle, summary: pairSummary }
    }
    // Every post is signed. The first time, Tinto asks whose name to sign with.
    const signer = authorship.author ? null : field('Sign as', '')
    if (signer) {
      signer.required = true
      signer.maxLength = 100
      signer.autocomplete = 'name'
      signer.placeholder = 'Your name as the author'
    }
    const origins = element('p', 'publish-authorship', (target.translationFrom ? 'Automatic translation from ' + target.translationFrom + ' · ' : '') + authorshipLine(authorship))
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
    // The partner shares the address, date, category and files. Its tags, image
    // descriptions and attachment titles are translated, and its summary too
    // when the writer left it empty.
    async function pairRequest(main: PublishRequest): Promise<PublishPair> {
      const texts = [...main.fields.tags, main.cover?.alt ?? '', ...main.images.map(image => image.alt), ...main.attachments.map(item => item.title)]
      const summaryEmpty = !pair!.summary.value.trim() && !!main.fields.summary.trim()
      if (summaryEmpty) texts.push(main.fields.summary)
      let translated = texts
      if (texts.some(text => text.trim()) && await api.translatorStatus()) {
        status.textContent = 'Translating tags and image descriptions…'
        translated = await api.translateTexts(texts, target.language, partner!.language)
      }
      const take = (() => { let at = 0; return (count: number) => translated.slice(at, at += count) })()
      const tags = take(main.fields.tags.length).map(tag => tag.trim()).filter(Boolean)
      const [coverAlt] = take(1)
      const alts = take(main.images.length)
      const titles = take(main.attachments.length)
      const [pairSummary] = summaryEmpty ? take(1) : [pair!.summary.value]
      if (summaryEmpty) pair!.summary.value = pairSummary
      return {
        documentId: partner!.documentId,
        fields: { ...main.fields, title: pair!.title.value, summary: pairSummary, tags },
        cover: main.cover ? { ...main.cover, alt: coverAlt } : null,
        images: main.images.map((image, index) => ({ ...image, alt: alts[index] })),
        attachments: main.attachments.map((item, index) => ({ ...item, title: titles[index] || item.title }))
      }
    }
    function send(state: PostStatus) {
      return run(async () => {
        await ensureAuthor()
        const main = request(state) as PublishRequest
        if (pair?.include.checked) main.pair = await pairRequest(main)
        status.textContent = main.pair ? 'Publishing both posts…' : 'Preparing the post…'
        return api.publishPost(main)
      }, 'Preparing the post…', sent => (state === 'draft'
        ? 'Saved “' + title.value.trim() + '” as a draft on ' + site.name + '.'
        : 'Published “' + title.value.trim() + '” on ' + site.name + '.')
        + (sent.pair ? ' Also ' + (state === 'draft' ? 'saved' : 'published') + ' “' + sent.pair.title + '”.' : '')
        + (sent.verified ? '' : unverified))
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
