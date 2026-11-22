// Small line icons share a 24-unit grid and inherit the system appearance.
const paths: Record<string, string> = {
  home: '<path d="m3 10 9-7 9 7v10H4V10m5 10v-7h6v7"/>',
  book: '<path d="M4 4h14a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2V4Zm0 14c0-1 1-2 3-2h13M8 5v11"/>',
  folder: '<path d="M3 7V5h6l2 3h10v11H3V7Z"/>',
  link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 6 0m0 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-5-5l-1 1"/>',
  outline: '<path d="M4 5h16M8 12h12M8 19h12"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  settings: '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 21h16"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-3c0-5 12 1 12-5"/>',
  // A sheet with a pencil: a working copy of a document, distinct from the branch of alternatives.
  draft: '<path d="M12 21H5V3h8l5 5v4"/><path d="M13 3v5h5"/><path d="m14 20 6-6 2 2-6 6h-2z"/>',
  pencil: '<path d="m15 5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.8 15Z"/>',
  undo: '<path d="M4 6v6h6M4 12l3-3c5-5 13-2 13 6v2"/>',
  redo: '<path d="M20 6v6h-6m6 0-3-3C12 4 4 7 4 15v2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 4v16m-8-8h16"/>',
  page: '<path d="M6 3h9l4 4v14H6V3Zm8 0v6h5M9 13h7m-7 4h5"/>',
  leaf: '<path d="M5 18C4 8 12 4 21 3c-1 9-4 16-14 15m-3 3L15 10"/>',
  // A clipboard: text that came from somewhere else.
  origins: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8m-8 4h5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.2v.1"/>'
}
export function icon(name: string): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = paths[name] ?? ''
  return el
}
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}
export function button(text: string, run: () => void, className = '', symbol?: string): HTMLButtonElement {
  const el = element('button', className, text)
  if (symbol) el.prepend(icon(symbol))
  el.type = 'button'
  el.onclick = run
  return el
}
export function $(id: string): HTMLElement { return document.getElementById(id)! }

export function spawnButton(title: string, exists: boolean, open: () => void) {
  const action = button('', open, 'spawn-button', exists ? 'link' : 'plus')
  action.title = (exists ? 'Open spawn for ' : 'Create spawn for ') + title
  action.setAttribute('aria-label', action.title)
  return action
}
// Electron prefixes errors from the main process with the IPC channel name.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
}

export function contextMenu(): HTMLElement {
  const menu = element('div', 'context-menu')
  menu.popover = 'auto'
  menu.setAttribute('role', 'menu')
  menu.addEventListener('focusout', event => { if (!menu.contains(event.relatedTarget as Node)) menu.hidePopover() })
  return menu
}

export function attachMenu(row: HTMLButtonElement, menu: HTMLElement, title: string, commands: [string, () => void][]) {
  row.setAttribute('aria-haspopup', 'menu')
  function open(x: number, y: number) {
    row.focus({ preventScroll: true })
    function command(label: string, run: () => void) {
      const entry = button(label, () => { menu.hidePopover(); run() })
      entry.setAttribute('role', 'menuitem')
      return entry
    }
    const entries = commands.map(([label, run]) => command(label, run))
    menu.replaceChildren(...entries)
    menu.setAttribute('aria-label', 'Actions for ' + title)
    menu.showPopover({ source: row })
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px'
    // Scrolling any ancestor moves the row away from the menu, so it closes.
    const close = (event: Event) => { if (!menu.contains(event.target as Node) && menu.matches(':popover-open')) menu.hidePopover() }
    const closed = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'closed') return
      removeEventListener('scroll', close, { capture: true })
      menu.removeEventListener('toggle', closed)
    }
    addEventListener('scroll', close, { capture: true })
    menu.addEventListener('toggle', closed)
    entries[0].focus({ preventScroll: true })
    menu.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const index = entries.indexOf(document.activeElement as HTMLButtonElement)
        entries[(index + direction + entries.length) % entries.length].focus()
      }
    }
  }
  row.oncontextmenu = event => { event.preventDefault(); open(event.clientX, event.clientY) }
  row.onkeydown = event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const { left, bottom } = row.getBoundingClientRect()
    open(left, bottom)
  }
}
