import type { PostImageChoice, PostRecord, PublishResult } from './project-types'
import { dialogHeader } from './settings'
import { button, element, errorMessage as errorText } from './ui'

export interface PublishTarget { documentId: string; headingId: string | null; title: string; languageName: string }
type Choice = { alt: string; name: string } & ({ key: string } | { token: string })
const largest = 15 * 1024 * 1024

export function slugify(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
}

function describe(post: PostRecord | null): string {
  if (!post) return 'Not published yet. Tinto uploads the images to R2, saves the post in D1 and starts a site rebuild.'
  if (post.removed) return 'Removed from the site database. The site has not rebuilt yet, so the post is still visible.'
  const when = new Date(post.publishedAt).toLocaleString()
  if (post.deployPending) return 'Saved to the site database on ' + when + '. The site has not rebuilt yet.'
  return 'Published · ' + when + ' · ' + post.slug
}

export async function showPublish(dialog: HTMLDialogElement, target: PublishTarget, openSettings: () => void, notice: (text: string) => void) {
  const api = window.tinto
  const [site, saved] = await Promise.all([api.siteStatus(), api.loadPost(target.documentId, target.headingId)])
  if (!site.connected) {
    const actions = element('div', 'dialog-actions')
    actions.append(button('Cancel', () => dialog.close(), 'outline'), button('Open Settings', () => { dialog.close(); openSettings() }, 'primary'))
    dialog.replaceChildren(dialogHeader(dialog, 'Publish'), element('p', '', 'Connect your Cloudflare site in Settings, then publish this ' + (target.headingId ? 'section' : 'document') + ' as a post.'), actions)
    if (!dialog.open) dialog.showModal()
    return
  }

  function render(post: PostRecord | null, note: string) {
    const live = post && !post.removed ? post : null
    const form = element('form', 'publish-form')
    function field(label: string, value: string, type = 'text') {
      const row = element('label', 'field', label)
      const input = element('input')
      input.type = type
      input.value = value
      row.append(input)
      form.append(row)
      return input
    }
    const title = field('Title', live?.title ?? target.title)
    title.required = true
    title.maxLength = 200
    const slug = field('Address', live?.slug ?? slugify(target.title))
    slug.required = true
    slug.maxLength = 100
    slug.spellcheck = false
    let slugEdited = !!live
    slug.oninput = () => { slugEdited = true }
    title.oninput = () => { if (!slugEdited) slug.value = slugify(title.value) }
    const date = field('Date', live?.date ?? new Date().toLocaleDateString('en-CA'), 'date')
    date.required = true
    const summaryRow = element('label', 'field stacked', 'Summary')
    const summary = element('textarea')
    summary.rows = 3
    summary.maxLength = 500
    summary.value = live?.summary ?? ''
    summaryRow.append(summary)
    form.append(summaryRow)
    const tags = field('Tags', (live?.tags ?? []).join(', '))
    tags.placeholder = 'Separated by commas'
    form.append(element('p', '', 'Language · ' + target.languageName))

    let cover: Choice | null = live?.cover ? { key: live.cover.key, alt: live.cover.alt, name: live.cover.name } : null
    const gallery: Choice[] = live?.images.map(image => ({ key: image.key, alt: image.alt, name: image.name })) ?? []
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
    status.textContent = note || describe(post)
    const actions = element('div', 'dialog-actions')
    form.append(status, actions)
    const controls = () => form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')
    function run(task: () => Promise<PublishResult>, progress: string, done: () => string) {
      return async () => {
        controls().forEach(el => el.disabled = true)
        status.textContent = progress
        try {
          const result = await task()
          if (result.deployError) { render(result.post, 'Saved, but the site rebuild did not start. ' + result.deployError); return }
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
      if (post?.deployPending) actions.append(button('Retry rebuild', run(() => api.rebuildSite(target.documentId, target.headingId), 'Starting the rebuild…', () => 'The site is rebuilding.'), 'outline'))
      if (live) actions.append(button('Unpublish', () => {
        status.textContent = 'Remove this post from D1 and its images from R2, then rebuild the site? The document stays in Tinto.'
        actions.replaceChildren(
          button('Keep post', () => { status.textContent = describe(post); drawActions() }, 'outline'),
          button('Remove from site', run(() => api.unpublishPost(target.documentId, target.headingId), 'Removing the post…', () => 'Removed “' + live.title + '” from the site. The site is rebuilding.'), 'primary')
        )
      }, 'outline'))
      const submit = element('button', 'primary', live ? 'Update post' : 'Publish')
      submit.type = 'submit'
      actions.append(button('Cancel', () => dialog.close(), 'outline'), submit)
    }
    drawActions()
    const choice = (item: Choice): PostImageChoice => 'key' in item ? { key: item.key, alt: item.alt } : { token: item.token, alt: item.alt }
    form.onsubmit = event => {
      event.preventDefault()
      void run(() => api.publishPost({
        documentId: target.documentId, headingId: target.headingId,
        fields: { title: title.value, slug: slug.value, summary: summary.value, date: date.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean) },
        cover: cover ? choice(cover) : null, images: gallery.map(choice)
      }), 'Uploading images and saving the post…', () => 'Published “' + title.value.trim() + '”. The site is rebuilding.')()
    }
    dialog.replaceChildren(dialogHeader(dialog, live ? 'Update post' : 'Publish'), form)
    if (!dialog.open) dialog.showModal()
  }
  render(saved, '')
}
