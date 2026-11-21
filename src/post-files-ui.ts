import { FILE_CLASSES, FILE_TYPES, extensionOf } from '../modules/cloudflare/files.mjs'
import type { FilePick, PickedFile, PostAttachmentChoice, PostImageChoice, PostRecord } from './project-types'
import { button, element, errorMessage } from './ui'

// The cover, gallery and attachments of a post, as the Publish dialog edits
// them. Files already on the website are named by file; new ones by the token
// the main process issued when the writer chose them.
type ImageChoice = { alt: string; name: string } & ({ file: string } | { token: string })
type AttachmentChoice = { title: string; name: string; size: number } & ({ file: string } | { token: string })

const sizeText = (bytes: number) => bytes < 1_048_576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1_048_576).toFixed(1) + ' MB'
const titleOf = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120) || name
// Larger than its class allows, judged by the name before Tinto reads the file.
function tooLarge(file: PickedFile) {
  const kind = FILE_TYPES[extensionOf(file.name)]
  const limit = kind ? FILE_CLASSES[kind.class].max : Infinity
  return file.size > limit ? file.name + ' is larger than ' + Math.round(limit / 1_048_576) + ' MB' : ''
}

export function postFilesEditor(post: PostRecord | null, say: (text: string) => void) {
  const api = window.tinto
  let cover: ImageChoice | null = post?.cover ? { file: post.cover.file, alt: post.cover.alt, name: post.cover.name } : null
  const gallery: ImageChoice[] = post?.images.map(image => ({ file: image.file, alt: image.alt, name: image.name })) ?? []
  const attachments: AttachmentChoice[] = post?.attachments.map(item => ({ file: item.file, title: item.title, name: item.name, size: item.size })) ?? []
  const host = element('div', 'post-files')
  const coverHost = element('section', 'post-images')
  const galleryHost = element('section', 'post-images')
  const attachmentHost = element('section', 'post-images')
  host.append(coverHost, galleryHost, attachmentHost)

  function row(name: string, label: string, value: string, maxLength: number, placeholder: string, change: (text: string) => void, remove: () => void, detail = '') {
    const line = element('div', 'post-image')
    const input = element('input')
    input.type = 'text'
    input.value = value
    input.maxLength = maxLength
    input.placeholder = placeholder
    input.setAttribute('aria-label', label + ' ' + name)
    input.oninput = () => change(input.value)
    const removal = button('Remove', remove, 'outline')
    removal.setAttribute('aria-label', 'Remove ' + name)
    const caption = element('span', 'post-image-name', name)
    if (detail) caption.title = detail
    line.append(caption, input, removal)
    return line
  }
  function draw() {
    coverHost.replaceChildren(element('h3', 'group-label', 'Cover image'))
    if (cover) coverHost.append(row(cover.name, 'Description of', cover.alt, 300, 'Describe the image', text => { cover!.alt = text }, () => { cover = null; draw() }))
    coverHost.append(button(cover ? 'Replace cover' : 'Choose cover', () => void pick('cover'), 'outline'))
    galleryHost.replaceChildren(element('h3', 'group-label', 'Gallery'))
    gallery.forEach((choice, index) => galleryHost.append(row(choice.name, 'Description of', choice.alt, 300, 'Describe the image', text => { choice.alt = text }, () => { gallery.splice(index, 1); draw() })))
    galleryHost.append(button('Add images', () => void pick('gallery'), 'outline'))
    attachmentHost.replaceChildren(element('h3', 'group-label', 'Attachments'))
    attachmentHost.append(element('p', 'post-files-note', 'PDF documents, audio, video, ZIP and CSV files. The website shows each one by its title.'))
    attachments.forEach((choice, index) => {
      const ext = extensionOf(choice.name).toUpperCase()
      attachmentHost.append(row(choice.name, 'Title of', choice.title, 120, 'Title shown on the website', text => { choice.title = text }, () => { attachments.splice(index, 1); draw() }, ext + ' · ' + sizeText(choice.size)))
    })
    attachmentHost.append(button('Attach files', () => void pick('attachments'), 'outline'))
  }
  async function pick(kind: FilePick) {
    try {
      const files = await api.pickFiles(kind)
      const refused = files.map(tooLarge).filter(Boolean)
      const accepted = files.filter(file => !tooLarge(file))
      if (kind === 'cover' && accepted[0]) cover = { token: accepted[0].token, name: accepted[0].name, alt: '' }
      if (kind === 'gallery') gallery.push(...accepted.map(file => ({ token: file.token, name: file.name, alt: '' })))
      if (kind === 'attachments') attachments.push(...accepted.map(file => ({ token: file.token, name: file.name, size: file.size, title: titleOf(file.name) })))
      draw()
      if (refused.length) say(refused.join('; ') + ', so it was not added.')
    } catch (error) { say(errorMessage(error)) }
  }
  draw()

  const image = (item: ImageChoice): PostImageChoice => 'file' in item ? { file: item.file, alt: item.alt } : { token: item.token, alt: item.alt }
  const attachment = (item: AttachmentChoice): PostAttachmentChoice => 'file' in item ? { file: item.file, title: item.title } : { token: item.token, title: item.title }
  return {
    element: host,
    values: () => ({ cover: cover ? image(cover) : null, images: gallery.map(image), attachments: attachments.map(attachment) })
  }
}
