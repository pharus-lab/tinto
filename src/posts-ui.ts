import type { PostOverview, SiteSummary } from './project-types'
import { dialogHeader } from './settings'
import { button, element } from './ui'

// Every post of the open project, grouped by website and then by the website's
// category, with whether each one is a draft, live, or changed since its release.
export function postLabel(post: PostOverview): string {
  if (post.status === 'draft') return 'Draft'
  return post.changed ? 'Changed since the release' : 'Live'
}

export async function showPosts(dialog: HTMLDialogElement, open: (documentId: string, headingId: string | null) => void) {
  const api = window.tinto
  const [posts, sites] = await Promise.all([api.allPosts(), api.sites()])
  const body = element('div', 'posts-overview')
  if (!posts.length) body.append(element('p', '', 'No document in this project has been published or saved as a draft on a website yet.'))
  const bySite = new Map<string, PostOverview[]>()
  for (const post of posts) bySite.set(post.siteId, [...(bySite.get(post.siteId) ?? []), post])
  for (const [siteId, list] of bySite) {
    const site: SiteSummary | undefined = sites.find(item => item.id === siteId)
    const section = element('section', 'posts-site')
    section.append(element('h3', '', site?.name ?? list[0].siteName ?? 'A removed website'))
    const labels = new Map((site?.categories ?? []).map(item => [item.id, item.label]))
    const byCategory = new Map<string, PostOverview[]>()
    for (const post of list) byCategory.set(post.category, [...(byCategory.get(post.category) ?? []), post])
    for (const [category, entries] of byCategory) {
      if (byCategory.size > 1 || category) section.append(element('h4', 'group-label', category ? labels.get(category) ?? category : 'No category'))
      const items = element('ul', 'posts-list')
      for (const post of entries.sort((a, b) => b.date.localeCompare(a.date))) {
        const item = element('li', 'posts-entry')
        const link = button(post.title, () => { dialog.close(); open(post.documentId, post.headingId) }, 'posts-title')
        link.setAttribute('aria-label', 'Open ' + post.title)
        const where = post.documentTitle + (post.headingId ? ' · section' : '') + ' · ' + post.date
        item.append(link, element('span', 'posts-state' + (post.status === 'draft' ? ' draft' : post.changed ? ' changed' : ''), postLabel(post)), element('span', 'path', where))
        items.append(item)
      }
      section.append(items)
    }
    body.append(section)
  }
  const actions = element('div', 'dialog-actions')
  actions.append(button('Close', () => dialog.close(), 'outline'))
  dialog.replaceChildren(dialogHeader(dialog, 'Posts'), body, actions)
  if (!dialog.open) dialog.showModal()
}
