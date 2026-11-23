import type { ManuscriptFont } from './project-types'
import { applyPreferences, type Preferences } from './settings'
import { SYSTEM_FONTS, THEMES, listCharacters, registerFontFaces, userFont } from './typography'
import { button, element, errorMessage } from './ui'

// Settings → Appearance: the theme above Appearance, and the manuscript font first
// in the Text group. A theme is a paper and its ink, for light and dark; Appearance
// picks between them.
export function typographySettings(groups: { theme: HTMLElement, text: HTMLElement }, prefs: Preferences, characters: () => string | null) {
  const api = window.tinto
  let fonts: ManuscriptFont[] = []
  let loaded = false
  const heading = element('h3', 'group-label', 'Theme')
  heading.id = 'theme-heading'
  const themes = element('div', 'theme-picker')
  themes.setAttribute('role', 'radiogroup')
  themes.setAttribute('aria-labelledby', heading.id)
  for (const [id, name] of THEMES) {
    const choice = element('label', 'theme-choice')
    const input = element('input')
    input.type = 'radio'
    input.name = 'theme'
    input.value = id
    input.checked = prefs.theme === id
    input.onchange = () => { prefs.theme = id; applyPreferences(prefs) }
    // The sample is drawn in the theme's own paper, ink and accent.
    const sample = element('span', 'theme-sample')
    sample.dataset.theme = id
    sample.setAttribute('aria-hidden', 'true')
    sample.append(element('span', 'theme-letters', 'Aa'), element('span', 'theme-accent'))
    choice.append(input, sample, element('span', 'theme-name', name))
    themes.append(choice)
  }

  const row = element('label', 'field', 'Manuscript font')
  const select = element('select')
  select.setAttribute('aria-label', 'Manuscript font')
  row.append(select)
  const actions = element('div', 'field-actions')
  const status = element('p', 'font-status settings-note')
  status.setAttribute('role', 'status')
  const add = button('Add font…', () => void addFonts(), 'outline')
  const remove = button('Remove font', () => void removeFont(), 'outline')
  actions.append(add, remove)
  groups.theme.prepend(heading, themes)
  groups.text.querySelector('.group-label')!.after(row, actions, status)

  const selected = () => fonts.find(font => userFont(font.id) === prefs.font) ?? null
  function draw() {
    select.replaceChildren(...SYSTEM_FONTS.map(([id, name]) => new Option(name, id)))
    if (fonts.length) {
      const group = element('optgroup')
      group.label = 'Added fonts'
      group.append(...fonts.map(font => new Option(font.family, userFont(font.id))))
      select.append(group)
    }
    select.value = prefs.font
    // An added font is known once the list has loaded; until then the choice is kept.
    if (select.selectedIndex < 0 && loaded) select.value = prefs.font = 'book'
    remove.hidden = !selected()
  }
  function busy(on: boolean) { for (const control of [select, add, remove]) control.disabled = on }
  // A font Tinto can read is checked against every character in the project.
  async function describe(prefix = '') {
    const font = selected()
    if (!font) {
      status.textContent = prefix + 'A font on this computer. Characters it cannot draw appear in a fallback font.'
      return
    }
    const text = characters()
    if (text === null) { status.textContent = prefix + 'Open a project to check “' + font.family + '” against your text.'; return }
    const check = await api.checkFont(font.id, text)
    const styles = font.faces.length + (font.faces.length === 1 ? ' style' : ' styles')
    if (!check?.missing.length) status.textContent = prefix + '“' + font.family + '” (' + styles + ') draws every character in this project.'
    else status.textContent = prefix + '“' + font.family + '” cannot draw ' + check.missing.length + (check.missing.length === 1 ? ' character' : ' characters')
      + ' in this project: ' + listCharacters(check.missing) + '. They appear in a fallback font.'
  }
  select.onchange = () => {
    prefs.font = select.value
    applyPreferences(prefs)
    remove.hidden = !selected()
    void describe().catch(error => { status.textContent = errorMessage(error) })
  }
  async function addFonts() {
    busy(true)
    try {
      const result = await api.addFonts(characters() ?? '')
      if (!result) return
      fonts = result.fonts
      registerFontFaces(fonts)
      if (result.added[0]) prefs.font = userFont(result.added[0])
      applyPreferences(prefs)
      draw()
      await describe('Added. ')
    } catch (error) { status.textContent = errorMessage(error) }
    finally { busy(false) }
  }
  async function removeFont() {
    const font = selected()
    if (!font) return
    busy(true)
    try {
      fonts = await api.removeFont(font.id)
      registerFontFaces(fonts)
      prefs.font = 'book'
      applyPreferences(prefs)
      draw()
      status.textContent = 'Removed “' + font.family + '”. The manuscript uses Book serif.'
    } catch (error) { status.textContent = errorMessage(error) }
    finally { busy(false) }
  }
  draw()
  void api.fonts().then(list => { fonts = list; loaded = true; draw(); return describe() }).catch(error => { status.textContent = errorMessage(error) })
}
