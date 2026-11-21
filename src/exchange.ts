import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { markTags, newBlock, type BlockJSON, type InlineJSON, type Manuscript, type MarkJSON, type TextJSON } from './model'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export interface ImportedFile { manuscript: Manuscript; notes: string[] }
export interface InputFile { name: string; bytes: Uint8Array }
export type ExportFormat = 'docx' | 'pdf'
const xml = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const xmlFile = (value: string) => strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value)
const descendants = (el: XMLDocument | Element, name: string) => [...el.getElementsByTagNameNS(word, name)]
const attr = (el: Element | undefined, name: string) => el?.getAttributeNS(word, name) ?? ''
const child = (el: Element | undefined, name: string) => el && [...el.children].find(item => item.namespaceURI === word && item.localName === name)
const headingSizes = [18, 17, 16, 15, 14, 13]
export const printStyles = `
  @page { size: A4; margin: 1in; }
  body { margin: 0; font: 12pt/1.333 Georgia, serif; color: #262123; }
  p, h1, h2, h3, h4, h5, h6 { margin: 0 0 8pt; white-space: pre-wrap; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  ${headingSizes.map((size, index) => 'h' + (index + 1) + ' { font-size: ' + size + 'pt; }').join('\n')}
  u { text-decoration-thickness: .065em; text-underline-offset: .14em; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`

function activeRuns(nodes: InlineJSON[]): TextJSON[] {
  return nodes.flatMap(node => node.type === 'text' ? [node] : activeRuns(node.content ?? []))
}
function blockHTML(block: BlockJSON, empty: string): string {
  const tag = block.type === 'heading' ? 'h' + Math.max(1, Math.min(6, block.attrs.level ?? 1)) : 'p'
  const runs = activeRuns(block.content ?? []).map(run => {
    let value = xml(run.text)
    for (const mark of run.marks ?? []) {
      const name = markTags[mark.type]
      value = '<' + name + '>' + value + '</' + name + '>'
    }
    return value
  })
  return '<' + tag + '>' + (runs.join('') || empty) + '</' + tag + '>'
}
export function documentHTML(doc: Manuscript): string {
  return doc.content.map(block => blockHTML(block, '<br>')).join('\n')
}
// A post carries the chosen wording only. Blank paragraphs are spacing in a
// manuscript, not content, so the site never receives empty elements.
export function postHTML(blocks: BlockJSON[]): string {
  return blocks.filter(block => activeRuns(block.content ?? []).some(run => run.text.trim())).map(block => blockHTML(block, '')).join('\n')
}
export function writeDocx(doc: Manuscript): Uint8Array {
  const paragraphs = doc.content.map(block => {
    const style = block.type === 'heading' ? '<w:pPr><w:pStyle w:val="Heading' + block.attrs.level + '"/></w:pPr>' : ''
    const runs = activeRuns(block.content ?? []).map(run => {
      const marks = run.marks?.map(mark => ({ strong: '<w:b/>', em: '<w:i/>', highlight: '<w:u w:val="single"/>' })[mark.type]).join('') ?? ''
      return '<w:r><w:rPr>' + marks + '</w:rPr><w:t xml:space="preserve">' + xml(run.text) + '</w:t></w:r>'
    })
    return '<w:p>' + style + runs.join('') + '</w:p>'
  })
  const headings = headingSizes.map((size, index) => '<w:style w:type="paragraph" w:styleId="Heading' + (index + 1) + '"><w:name w:val="heading ' + (index + 1) + '"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="' + index + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + (size * 2) + '"/></w:rPr></w:style>')
  return zipSync({
    '[Content_Types].xml': xmlFile('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': xmlFile('<Relationships xmlns="' + rels + '"><Relationship Id="rId1" Type="' + office + '/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': xmlFile('<Relationships xmlns="' + rels + '"><Relationship Id="rId1" Type="' + office + '/styles" Target="styles.xml"/></Relationships>'),
    'word/styles.xml': xmlFile('<w:styles xmlns:w="' + word + '"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:style>' + headings.join('') + '</w:styles>'),
    'word/document.xml': xmlFile('<w:document xmlns:w="' + word + '"><w:body>' + paragraphs.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>')
  })
}
function readDocx(bytes: Uint8Array): ImportedFile {
  const files = unzipSync(bytes, { filter: file => ['word/document.xml','word/styles.xml','word/comments.xml'].includes(file.name) })
  if (!files['word/document.xml']) throw Error('This file does not contain a Word document.')
  const parse = (file: string) => new DOMParser().parseFromString(strFromU8(files[file]), 'application/xml')
  const doc = parse('word/document.xml')
  const content = descendants(doc, 'body')[0]
  if (!content) throw Error('The document XML could not be read.')
  const styles = new Map<string, Element>()
  if (files['word/styles.xml']) for (const style of descendants(parse('word/styles.xml'), 'style')) styles.set(attr(style, 'styleId'), style)
  function inheritance(id: string): Element[] {
    const chain: Element[] = []
    let style = styles.get(id)
    while (style && !chain.includes(style)) {
      chain.unshift(style)
      style = styles.get(attr(child(style, 'basedOn'), 'val'))
    }
    return chain
  }
  const notes: string[] = []
  const count = (tag: string) => descendants(content, tag).length
  if (count('tbl')) notes.push('Table cells were imported as paragraphs.')
  if (count('drawing') || count('pict')) notes.push('Images and drawing layout were omitted.')
  if (files['word/comments.xml'] || count('commentRangeStart')) notes.push('Comments were omitted.')
  if (count('ins') || count('del') || count('moveFrom') || count('moveTo')) notes.push('Tracked revisions were imported as their accepted text.')
  if (count('hyperlink')) notes.push('Links were imported as text.')
  const blocks: BlockJSON[] = []
  for (const p of descendants(content, 'p')) {
    const insideSkipped = (el: Element) => ['del','moveFrom','drawing','pict'].includes(el.localName)
    function skipped(el: Element) {
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) if (insideSkipped(ancestor)) return true
      return false
    }
    if (skipped(p)) continue
    const props = child(p, 'pPr')
    const styleId = attr(child(props, 'pStyle'), 'val')
    const chain = inheritance(styleId)
    const styleNames = [styleId, ...chain.map(style => attr(child(style,'name'), 'val'))]
    const heading = styleNames.map(name => /heading\s*([1-6])/i.exec(name)).find(Boolean)
    const paraProps = [...chain.map(s => child(s, 'pPr')), props]
    const outline = paraProps.map(s => child(s, 'outlineLvl')).filter(Boolean).at(-1)
    const level = outline ? Number(attr(outline, 'val')) + 1 : heading ? Number(heading[1]) : 0
    let block = newBlock('', level > 0 && level <= 6 ? level : undefined)
    blocks.push(block)
    for (const run of descendants(p, 'r')) {
      if (skipped(run)) continue
      const rpr = child(run, 'rPr')
      const inherited = [...chain, ...inheritance(attr(child(rpr, 'rStyle'), 'val'))].map(style => child(style, 'rPr'))
      const marks: MarkJSON[] = []
      const property = (name: string) => [...inherited, rpr].map(s => child(s, name)).filter(Boolean).at(-1)
      const enabled = (prop: Element | undefined) => !!prop && !['none','false','0','off'].includes(attr(prop, 'val'))
      if (enabled(property('b'))) marks.push({ type: 'strong' })
      if (enabled(property('i'))) marks.push({ type: 'em' })
      const highlight = property('highlight')
      const oldHighlight = highlight ? enabled(highlight) : attr(property('shd'), 'fill').toUpperCase() === 'F2D88F'
      // Inside a link, only an underline set on the run itself is the author's.
      const linked = run.parentElement?.localName === 'hyperlink' || attr(child(rpr, 'rStyle'), 'val') === 'Hyperlink'
      if (enabled(linked ? child(rpr, 'u') : property('u')) || oldHighlight) marks.push({ type: 'highlight' })
      for (const node of run.children) {
        if (node.localName === 'br' || node.localName === 'cr') { block = newBlock(); blocks.push(block); continue }
        const text = node.localName === 'tab' ? '\t' : node.localName === 't' ? node.textContent : ''
        if (text) (block.content ??= []).push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
      }
    }
  }
  return { manuscript: { type: 'doc', content: blocks.length ? blocks : [newBlock()] }, notes }
}
async function readPDF(bytes: Uint8Array): Promise<ImportedFile> {
  const pdfModule = new URL('pdf.mjs', document.baseURI).href
  const { getDocument, GlobalWorkerOptions }: typeof import('pdfjs-dist') = await import(pdfModule)
  GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', document.baseURI).href
  const task = getDocument({ data: bytes, useSystemFonts: true })
  const pdf = await task.promise
  const blocks: BlockJSON[] = []
  let emptyPages = 0
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const layer = await page.getTextContent()
      let text = ''
      let lastY: number | undefined
      let lastEnd = 0
      let lastHeight = 0
      const first = blocks.length
      function endParagraph() { if (text.trim()) blocks.push(newBlock(text.trim())); text = '' }
      for (const item of layer.items) {
        if (!('str' in item) || !item.str) continue
        const x = item.transform[4], y = item.transform[5]
        const lineBreak = lastY !== undefined && Math.abs(y - lastY) > Math.max(2, lastHeight * .4)
        if (lastY !== undefined && (y > lastY + lastHeight || Math.abs(y - lastY) > lastHeight * 1.55)) endParagraph()
        if (text && !/\s$/.test(text) && (lineBreak || x - lastEnd > lastHeight * .12)) text += ' '
        text += item.str
        lastY = y; lastEnd = x + item.width; lastHeight = Math.max(1, Math.abs(item.height))
      }
      endParagraph()
      if (blocks.length === first) emptyPages++
      page.cleanup()
    }
  } finally { await task.destroy() }
  if (!blocks.length) throw Error('This PDF has no selectable text. Run OCR on the scan, then import the searchable PDF.')
  const notes = ['PDF text was extracted. Check paragraph breaks and reading order, especially on multi-column pages.']
  if (emptyPages) notes.push(emptyPages + ' page(s) had no selectable text and may need OCR.')
  return { manuscript: { type: 'doc', content: blocks }, notes }
}
export async function importFile(file: InputFile): Promise<ImportedFile> {
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (extension === 'docx') return readDocx(file.bytes)
  if (extension === 'pdf') return readPDF(file.bytes)
  if (extension !== 'txt') throw Error('Choose a TXT, DOCX, or PDF file.')
  return { manuscript: { type: 'doc', content: new TextDecoder().decode(file.bytes).split(/\r\n?|\n/).map(line => newBlock(line)) }, notes: [] }
}
