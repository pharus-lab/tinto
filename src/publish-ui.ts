import type { PostImageChoice, PostRecord, SiteSummary } from './project-types'
import { dialogHeader } from './settings'
import { button, element, errorMessage as errorText } from './ui'

export interface PublishTarget { documentId: string; headingId: string | null; title: string; languageName: string }
type Choice = { alt: string; name: string } & ({ file: string } | { token: string })
const largest = 15 * 1024 * 1024
// The website chosen last is offered first during this session.
let lastSite: string | null = null

export function slugify(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
}

function describe(site: SiteSummary, post: PostRecord | null): string {
  if (!post) return 'Not published on ' + site.name + ' yet.'
  return 'Published on ' + site.name + ' · ' + new Date(post.publishedAt).toLocaleString() + ' · ' + (post.url ?? post.slug)
}

export async function showPublish(dialog: HTMLDialogElement, target: PublishTarget, openSettings: () => void, notice: (text: string) => void) {
  const api = window.tinto
  const [sites, posts] = await Promise.all([api.sites(), api.posts(target.documentId, target.headingId)])
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
    // A post on another website supplies the text fields; images are chosen per website.
    const known = post ?? posts[0] ?? null
    const form = element('form', 'publish-form')
    const siteRow = element('label', 'field', 'Website')
    const picker = element('select')
    picker.setAttribute('aria-label', 'Website')
    for (const item of sites) {
      const option = element('option', '', item.name + (records.has(item.id) ? ' · published' : ''))
      option.value = item.id
      picker.append(option)
    }
    picker.value = site.id
    picker.onchange = () => render(sites.find(item => item.id === picker.value) ?? site)
    siteRow.append(picker)
    form.append(siteRow)
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

    let cover: Choice | null = post?.cover ? { file: post.cover.file, alt: post.cover.alt, name: post.cover.name } : null
    const gallery: Choice[] = post?.images.map(image => ({ file: image.file, alt: image.alt, name: image.name })) ?? []
    const coverHost = element('section', 'post-images')
    const galleryHost = element('section', 'post-images')
    form.append(coverHost, galleryHost)
    function imageRow(choice: Choice, remove: () => void) {
      const row = element('div', 'post-image')
      const alt = element('input')
      alt.type = 'text'
      alt.value = choice.alt
      alt.maxLength = 300
      alt.placeholder = 'Describe the image'
      alt.setAttribute('aria-label', 'Description of ' + choice.name)
      alt.oninput = () => { choice.alt = alt.value }
      const removal = button('Remove', remove, 'outline')
      removal.setAttribute('aria-label', 'Remove ' + choice.name)
      row.append(element('span', 'post-image-name', choice.name), alt, removal)
      return row
    }
    function drawImages() {
      coverHost.replaceChildren(element('h3', 'group-label', 'Cover image'))
      if (cover) coverHost.append(imageRow(cover, () => { cover = null; drawImages() }))
      coverHost.append(button(cover ? 'Replace cover' : 'Choose cover', () => void pick(false), 'outline'))
      galleryHost.replaceChildren(element('h3', 'group-label', 'Gallery'))
      gallery.forEach((choice, index) => galleryHost.append(imageRow(choice, () => { gallery.splice(index, 1); drawImages() })))
      galleryHost.append(button('Add images', () => void pick(true), 'outline'))
    }
    async function pick(multiple: boolean) {
      try {
        const files = await api.pickImages(multiple)
        const large = files.filter(file => file.size > largest)
        const choices: Choice[] = files.filter(file => file.size <= largest).map(file => ({ token: file.token, name: file.name, alt: '' }))
        if (multiple) gallery.push(...choices)
        else if (choices[0]) cover = choices[0]
        drawImages()
        status.textContent = large.length ? large.map(file => file.name).join(', ') + ' is larger than 15 MB and was not added.' : status.textContent
      } catch (error) { status.textContent = errorText(error) }
    }
    drawImages()

    const status = element('p', 'publish-status')
    status.setAttribute('role', 'status')
    status.textContent = describe(site, post)
    const actions = element('div', 'dialog-actions')
    form.append(status, actions)
    const controls = () => form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button, input, textarea, select')
    function run(task: () => Promise<unknown>, progress: string, done: () => string) {
      return async () => {
        controls().forEach(el => el.disabled = true)
        status.textContent = progress
        try {
          await task()
          dialog.close()
          notice(done())
        } catch (error) {
          controls().forEach(el => el.disabled = false)
          status.textContent = errorText(error)
        }
      }
    }
    function drawActions() {
      actions.replaceChildren()
      if (post) actions.append(button('Unpublish', () => {
        status.textContent = 'Remove this post from ' + site.name + '? The ' + kind + ' stays in Tinto.'
        actions.replaceChildren(
          button('Keep post', () => { status.textContent = describe(site, post); drawActions() }, 'outline'),
          button('Remove from site', run(() => api.unpublishPost(site.id, target.documentId, target.headingId), 'Removing the post…', () => 'Removed “' + post.title + '” from ' + site.name + '.'), 'primary')
        )
      }, 'outline'))
      const submit = element('button', 'primary', post ? 'Update post' : 'Publish')
      submit.type = 'submit'
      actions.append(button('Cancel', () => dialog.close(), 'outline'), submit)
    }
    drawActions()
    const choice = (item: Choice): PostImageChoice => 'file' in item ? { file: item.file, alt: item.alt } : { token: item.token, alt: item.alt }
    form.onsubmit = event => {
      event.preventDefault()
      void run(() => api.publishPost({
        siteId: site.id, documentId: target.documentId, headingId: target.headingId,
        fields: { title: title.value, slug: slug.value, summary: summary.value, date: date.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean) },
        cover: cover ? choice(cover) : null, images: gallery.map(choice)
      }), 'Uploading images and sending the post…', () => 'Published “' + title.value.trim() + '” on ' + site.name + '.')()
    }
    dialog.replaceChildren(dialogHeader(dialog, post ? 'Update post' : 'Publish'), form)
    if (!dialog.open) dialog.showModal()
  }
  render(sites.find(item => item.id === lastSite) ?? sites.find(item => records.has(item.id)) ?? sites[0])
}
