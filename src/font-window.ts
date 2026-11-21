import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { FONT_TYPES, readFace, type FontLibrary, type ReadFace } from './fonts'
import { listCharacters } from './typography'

interface FontContext {
  window(): BrowserWindow
  trusted(event: Electron.IpcMainInvokeEvent): void
}
// The renderer sends the characters of the open project; nothing else about it.
const characterSet = (value: unknown) => [...new Set(String(value ?? ''))].slice(0, 50_000).join('')

export function registerFonts(context: FontContext, fonts: FontLibrary) {
  ipcMain.handle('fonts:list', event => { context.trusted(event); return fonts.list() })
  // The writer picks the files of a family. Each is checked against every
  // character in the project before Tinto keeps it.
  ipcMain.handle('fonts:add', async (event, characters: string) => {
    context.trusted(event)
    const window = context.window()
    const choice = await dialog.showOpenDialog(window, {
      title: 'Add a manuscript font', buttonLabel: 'Add font', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fonts', extensions: Object.keys(FONT_TYPES) }]
    })
    if (choice.canceled || !choice.filePaths.length) return null
    const chars = characterSet(characters)
    const faces: ReadFace[] = []
    for (const path of choice.filePaths) {
      if ((await stat(path)).size > 30 * 1024 * 1024) throw Error(path.split(/[\\/]/).pop() + ' is larger than 30 MB.')
      faces.push(readFace(new Uint8Array(await readFile(path)), path, chars))
    }
    for (const family of [...new Set(faces.map(face => face.family))]) {
      const missing = [...new Set(faces.filter(face => face.family === family).flatMap(face => face.missing))]
      if (!missing.length) continue
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', buttons: ['Cancel', 'Add font'], defaultId: 0, cancelId: 0,
        message: '“' + family + '” cannot draw ' + missing.length + (missing.length === 1 ? ' character' : ' characters') + ' used in this project.',
        detail: listCharacters(missing) + '\n\nTinto shows them in a fallback font. You can add the font anyway, or choose one that covers them.'
      })
      if (answer.response !== 1) return null
    }
    const list = await fonts.add(faces)
    const added = [...new Set(faces.map(face => face.family.toLowerCase()))]
    return { fonts: list, added: list.filter(font => added.includes(font.family.toLowerCase())).map(font => font.id) }
  })
  ipcMain.handle('fonts:check', (event, id: string, characters: string) => { context.trusted(event); return fonts.check(String(id), characterSet(characters)) })
  ipcMain.handle('fonts:remove', (event, id: string) => { context.trusted(event); return fonts.remove(String(id)) })
}
