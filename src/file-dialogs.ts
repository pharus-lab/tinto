import type { BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { documentHTML, ebookHTML, exportFormats, markdownText, standaloneHTML, writeDocx, type ExportFormat, type InputFile } from './exchange'
import { visibleText, type Manuscript } from './model'

interface Conversion { bytes: Uint8Array<ArrayBuffer>; from: string; to: string; title?: string; language?: string }

// Pandoc's RTF reader can lose the letter after a smart quote and split a
// surrogate pair. Decode RTF Unicode controls before giving it the document.
function decodeRTFUnicode(bytes: Uint8Array<ArrayBuffer>) {
  const source = Buffer.from(bytes).toString('latin1')
  const controls = /[{}]|\\(?:([a-z]+)(-?\d+)? ?|'[\da-f]{2}|[\s\S])/gi
  const fallbackToken = /\\(?:'[\da-f]{2}|[a-z]+(?:-?\d+)? ?|[\s\S])|[^{}\\]/iy
  const fallbackCounts = [1]
  const parts: BlobPart[] = []
  let start = 0, unicode = ''
  function copyThrough(end: number) {
    if (unicode) parts.push('{' + unicode.replace(/[{}\\]/g, '\\$&') + '}')
    unicode = ''
    parts.push(bytes.subarray(start, end))
  }
  for (let match; (match = controls.exec(source));) {
    const [token, word, number] = match
    if (token === '{') fallbackCounts.push(fallbackCounts.at(-1)!)
    else if (token === '}') fallbackCounts.pop()
    else if (word === 'bin') controls.lastIndex += Math.max(0, Number(number) || 0)
    else if (word === 'uc') fallbackCounts[fallbackCounts.length - 1] = Number(number)
    else if (word === 'u' && number) {
      if (match.index !== start) copyThrough(match.index)
      unicode += String.fromCharCode(Number(number))
      fallbackToken.lastIndex = controls.lastIndex
      for (let count = 0; count < fallbackCounts.at(-1)!; count++) {
        if (!fallbackToken.exec(source)) break
        controls.lastIndex = fallbackToken.lastIndex
      }
      start = controls.lastIndex
    }
  }
  copyThrough(bytes.length)
  return new Blob(parts)
}

async function runConversion(job: Conversion) {
  const { convert } = await import('pandoc-wasm')
  const options = {
    from: job.from, to: job.to, 'input-files': ['source'], 'output-file': 'result', wrap: 'none',
    standalone: job.to === 'rtf', 'epub-title-page': false,
    metadata: job.to === 'epub3' ? { title: job.title, lang: job.language } : {}
  }
  const source = job.from === 'rtf' ? decodeRTFUnicode(job.bytes) : new Blob([job.bytes])
  const result = await convert(options, null, { source })
  if (!result.stderr && !result.files.result && job.to === 'html') return new Uint8Array()
  if (result.stderr || !result.files.result) throw Error(result.stderr.trim() || 'The document could not be converted.')
  return new Uint8Array(await result.files.result.arrayBuffer())
}

// Each conversion owns its in-memory filesystem and releases it on completion.
if (!isMainThread && parentPort) {
  const port = parentPort
  runConversion(workerData).then(bytes => port.postMessage(bytes, [bytes.buffer]), error => port.postMessage({ error: error.message }))
}

function convertDocument(from: string, to: string, bytes: Uint8Array, title?: string, language?: string): Promise<Uint8Array> {
  const path = join(__dirname, 'file-dialogs.mjs').replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
  const worker = new Worker(path, { workerData: { from, to, bytes, title, language } })
  return new Promise((resolve, reject) => {
    worker.once('message', result => result instanceof Uint8Array ? resolve(result) : reject(Error(result.error)))
    worker.once('error', reject)
    worker.once('exit', () => reject(Error('The document converter closed before returning a file.')))
  })
}

export async function pickInputFile(parent: BrowserWindow): Promise<InputFile | null> {
  const { dialog } = await import('electron')
  const extensions = [...Object.keys(exportFormats), 'htm', 'markdown']
  const selected = await dialog.showOpenDialog(parent, { title: 'Import a document', properties: ['openFile'], filters: [{ name: 'Manuscript files', extensions }] })
  if (selected.canceled) return null
  const path = selected.filePaths[0]
  const name = basename(path), extension = extname(path).slice(1).toLowerCase()
  const bytes = new Uint8Array(await readFile(path))
  const from = extension === 'md' || extension === 'markdown' ? 'gfm' : extension
  if (from === 'gfm' || from === 'rtf' || from === 'epub') {
    try {
      const html = await convertDocument(from, 'html', bytes)
      return { name, bytes: html, convertedToHTML: true, markdownSource: from === 'gfm' ? new TextDecoder().decode(bytes) : undefined }
    }
    catch (error) {
      if (from === 'epub') throw Error('Could not read this ebook. Choose a text-based, DRM-free EPUB.')
      throw error
    }
  }
  return { name, bytes }
}
export async function exportFile(parent: BrowserWindow, format: ExportFormat, title: string, manuscript: Manuscript, language: string) {
  if (!Object.hasOwn(exportFormats, format)) throw Error('Choose a supported export format.')
  const { BrowserWindow, dialog } = await import('electron')
  const result = await dialog.showSaveDialog(parent, { title: 'Export manuscript', defaultPath: title.replace(/[/\\:]/g, '-') + '.' + format, filters: [{ name: exportFormats[format], extensions: [format] }] })
  if (result.canceled || !result.filePath) return false
  let output: string | Uint8Array
  if (format === 'pdf') {
    const print = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, nodeIntegration: false, contextIsolation: true } })
    try {
      await print.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(standaloneHTML(manuscript, title)))
      output = await print.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    } finally { print.destroy() }
  } else if (format === 'docx') output = writeDocx(manuscript)
  else if (format === 'txt') output = visibleText(manuscript)
  else if (format === 'html') output = standaloneHTML(manuscript, title)
  else if (format === 'md' && manuscript.content.some(block => block.markdown)) output = markdownText(manuscript)
  else {
    const to = format === 'md' ? 'gfm' : format === 'epub' ? 'epub3' : format
    const html = format === 'epub' ? ebookHTML(manuscript, title) : documentHTML(manuscript, format === 'md' ? '&nbsp;' : '<br>')
    output = await convertDocument('html', to, new TextEncoder().encode(html), title, language)
  }
  await writeFile(result.filePath, output)
  return true
}
