import { BrowserWindow, dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { documentHTML, printStyles, writeDocx, type ExportFormat } from './exchange'
import type { Manuscript } from './model'

export async function pickInputFile(parent: BrowserWindow) {
  const selected = await dialog.showOpenDialog(parent, { title: 'Import a document', properties: ['openFile'], filters: [{ name: 'Manuscript files', extensions: ['txt', 'docx', 'pdf'] }] })
  if (selected.canceled) return null
  const path = selected.filePaths[0]
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
}
export async function exportFile(parent: BrowserWindow, format: ExportFormat, title: string, manuscript: Manuscript) {
  if (format !== 'docx' && format !== 'pdf') throw Error('Choose a PDF or DOCX export.')
  const result = await dialog.showSaveDialog(parent, { title: 'Export manuscript', defaultPath: title.replace(/[/\\:]/g, '-') + '.' + format, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
  if (result.canceled || !result.filePath) return false
  if (format === 'docx') { await writeFile(result.filePath, writeDocx(manuscript)); return true }
  const print = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, nodeIntegration: false, contextIsolation: true } })
  try {
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + printStyles + '</style></head><body>' + documentHTML(manuscript) + '</body></html>'
    await print.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await print.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    await writeFile(result.filePath, pdf)
    return true
  } finally { print.destroy() }
}
