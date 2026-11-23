// The tools the writer can show or hide in the document bar and the formatting
// bar (Settings → Appearance → Toolbar). Hidden tools keep their keyboard
// shortcuts; everything is shown until the writer hides it.
export interface Tool { id: string; label: string; bar: 'document' | 'formatting'; selectors: string[] }
export const TOOLS: Tool[] = [
  { id: 'export', label: 'Export', bar: 'document', selectors: ['#export'] },
  { id: 'publish', label: 'Publish', bar: 'document', selectors: ['#publish'] },
  { id: 'translate', label: 'Translate', bar: 'document', selectors: ['#translate'] },
  { id: 'drafts', label: 'Create and review drafts', bar: 'document', selectors: ['#draft-action'] },
  { id: 'history', label: 'History', bar: 'document', selectors: ['#history'] },
  { id: 'alternatives', label: 'Alternatives', bar: 'document', selectors: ['#toggle-alternatives'] },
  { id: 'paragraph-style', label: 'Paragraph style', bar: 'formatting', selectors: ['#block-style'] },
  { id: 'bold', label: 'Bold', bar: 'formatting', selectors: ['#toolbar [data-format=bold]'] },
  { id: 'italic', label: 'Italic', bar: 'formatting', selectors: ['#toolbar [data-format=italic]'] },
  { id: 'underline', label: 'Underline', bar: 'formatting', selectors: ['#toolbar [data-format=underline]'] },
  { id: 'markdown', label: 'Markdown', bar: 'formatting', selectors: ['#markdown'] },
  { id: 'add-alternative', label: 'Add alternative', bar: 'formatting', selectors: ['#add-alternative'] },
  { id: 'origins', label: 'Show pasted and imported text', bar: 'formatting', selectors: ['#show-origins'] },
  { id: 'check-writing', label: 'Check writing', bar: 'formatting', selectors: ['#check-writing'] },
  { id: 'undo-redo', label: 'Undo and redo', bar: 'formatting', selectors: ['#undo', '#redo'] }
]
export const toolIds = (ids: unknown): string[] => Array.isArray(ids) ? TOOLS.map(tool => tool.id).filter(id => ids.includes(id)) : []

export function applyToolbar(hidden: string[]) {
  for (const tool of TOOLS) for (const selector of tool.selectors) {
    document.querySelectorAll(selector).forEach(el => el.classList.toggle('tool-hidden', hidden.includes(tool.id)))
  }
  // A divider stays only between two groups that still show a tool.
  const bar = document.getElementById('toolbar')
  if (!bar) return
  let seen = false, pending: Element | null = null
  for (const el of bar.children) {
    if (el.classList.contains('tool-fill')) { seen = false; pending = null; continue }
    if (el.classList.contains('tool-rule')) { el.classList.add('tool-hidden'); if (seen) pending = el; continue }
    if (el.classList.contains('tool-hidden')) continue
    pending?.classList.remove('tool-hidden')
    pending = null; seen = true
  }
}
