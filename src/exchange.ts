import { parser as markdownParser } from '@lezer/markdown'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { formatMarks, markTags, newBlock, originOf, visibleText, type BlockJSON, type InlineJSON, type Manuscript, type MarkJSON, type TextJSON } from './model'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export interface ImportedFile { manuscript: Manuscript; notes: string[] }
export interface InputFile { name: string; bytes: Uint8Array; convertedToHTML?: boolean; markdownSource?: string }
export const exportFormats = { docx: 'Word document', pdf: 'PDF', txt: 'Plain text', md: 'Markdown', html: 'HTML', rtf: 'Rich text', odt: 'OpenDocument text', epub: 'EPUB' } as const
export type ExportFormat = keyof typeof exportFormats
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
    for (const mark of formatMarks(run.marks)) {
      const name = markTags[mark.type]
      value = '<' + name + '>' + value + '</' + name + '>'
    }
    return value
  })
  return '<' + tag + '>' + (runs.join('') || empty) + '</' + tag + '>'
}
export function documentHTML(doc: Manuscript, empty = '<br>'): string {
  return doc.content.map(block => blockHTML(block, empty)).join('\n')
}
// The editable spelling of each block travels with the manuscript. Keep choice
// nodes and text origins in the source so editing prose preserves both.
export function markdownInlines(block: BlockJSON): InlineJSON[] {
  if (block.markdown) return block.markdown.content
  function encode(nodes: InlineJSON[]): InlineJSON[] {
    const out: InlineJSON[] = []
    // Markdown emphasis delimiters cannot enclose leading or trailing spaces.
    const useTags = nodes.some(node => node.type === 'text' && formatMarks(node.marks).length && /^\s|\s$/.test(node.text))
    const delimiters = { strong: useTags ? '<strong>' : '**', em: useTags ? '<em>' : '*', highlight: '<u>' }
    let open: (keyof typeof delimiters)[] = []
    function changeMarks(next: typeof open) {
      let shared = 0
      while (shared < open.length && shared < next.length && open[shared] === next[shared]) shared++
      for (const mark of open.slice(shared).reverse()) out.push({ type: 'text', text: delimiters[mark].replace('<', '</') })
      for (const mark of next.slice(shared)) out.push({ type: 'text', text: delimiters[mark] })
      open = next
    }
    for (const node of nodes) {
      changeMarks(formatMarks(node.marks).map(mark => mark.type))
      if (node.type === 'choice') out.push({ ...node, content: encode(node.content ?? []) })
      else out.push({ ...node, text: node.text.replace(/[\\*_`<>\[\]~]/g, '\\$&'), marks: node.marks?.filter(mark => mark.type === 'origin') })
    }
    changeMarks([])
    return out
  }
  const content = encode(block.content ?? [])
  if (block.type === 'heading') content.unshift({ type: 'text', text: '#'.repeat(block.attrs.level ?? 1) + ' ' })
  else if (content[0]?.type === 'text') {
    content[0].text = content[0].text.replace(/^( {0,3})(#{1,6}|-+|\+)(?=\s|$)/, '$1\\$2').replace(/^( {0,3}\d{1,9})([.)])(?=\s)/, '$1\\$2')
  }
  return content
}

export function markdownText(doc: Manuscript) {
  return doc.content.map((block, index) => {
    const gap = block.markdown?.separator
    const separator = index === doc.content.length - 1 ? gap ?? '' : gap || '\n\n'
    return markdownInlines(block).map(visibleText).join('') + separator
  }).join('')
}

export function markdownFormatting(source: string) {
  const tree = markdownParser.parse(source)
  const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(tree.topNode.firstChild?.name ?? '')
  // The parser supplies source offsets. Slice the original runs at delimiters
  // so that neighbouring imported, typed and pasted words keep their marks.
  const hidden = new Uint8Array(source.length)
  const styles = { strong: new Uint8Array(source.length), em: new Uint8Array(source.length), highlight: new Uint8Array(source.length) }
  const opens = new Map<string, number[]>()
  tree.iterate({ enter(node) {
    if (node.name === 'HeaderMark' && heading) {
      let { from, to } = node
      if (from <= 3 && !source.slice(0, from).trim()) {
        from = 0
        while (to < source.length && /[ \t]/.test(source[to])) to++
      } else while (from > 0 && /\s/.test(source[from - 1])) from--
      hidden.fill(1, from, to)
    } else if (node.name === 'FencedCode') {
      const code = node.node.getChildren('CodeText')
      hidden.fill(1, node.from, code[0]?.from ?? node.to)
      hidden.fill(1, code.at(-1)?.to ?? node.to, node.to)
      return false
    } else if (node.name === 'EmphasisMark' || node.name === 'CodeMark') hidden.fill(1, node.from, node.to)
    else if (node.name === 'Link') {
      const [open, close] = node.node.getChildren('LinkMark')
      if (open && close) { hidden.fill(1, open.from, open.to); hidden.fill(1, close.from, node.to) }
    } else if (node.name === 'ListMark' || node.name === 'QuoteMark') {
      let end = node.to
      if (source[end] === ' ') end++
      hidden.fill(1, node.from, end)
    } else if (node.name === 'Escape') hidden[node.from] = 1
    else if (node.name === 'StrongEmphasis' || node.name === 'Emphasis') styles[node.name === 'Emphasis' ? 'em' : 'strong'].fill(1, node.from, node.to)
    else if (node.name === 'HTMLTag' || node.name === 'HTMLBlock') {
      const tag = /^<(\/?)(u|strong|em)>$/i.exec(source.slice(node.from, node.to))
      if (!tag) return
      const name = tag[2].toLowerCase()
      const stack = opens.get(name) ?? []
      if (!tag[1]) { stack.push(node.from); opens.set(name, stack); return }
      const start = stack.pop()
      if (start === undefined) return
      hidden.fill(1, start, start + name.length + 2)
      hidden.fill(1, node.from, node.to)
      styles[name === 'u' ? 'highlight' : name as 'strong' | 'em'].fill(1, start, node.to)
    }
  } })
  function* runs(from: number, to: number) {
    while (from < to) {
      const start = from++
      while (from < to && hidden[from] === hidden[start] && styles.strong[from] === styles.strong[start] && styles.em[from] === styles.em[start] && styles.highlight[from] === styles.highlight[start]) from++
      const marks = (['strong', 'em', 'highlight'] as const).filter(type => styles[type][start])
      yield { from: start, to: from, hidden: !!hidden[start], marks }
    }
  }
  return { level: heading ? Number(heading[1]) : null, runs }
}

export function readMarkdownBlock(content: InlineJSON[], id: string): BlockJSON {
  const source = content.map(visibleText).join('')
  const { level, runs } = markdownFormatting(source)
  const block: BlockJSON = level ? { type: 'heading', attrs: { id, level } } : { type: 'paragraph', attrs: { id } }
  let offset = 0
  function decode(nodes: InlineJSON[]): InlineJSON[] {
    const out: InlineJSON[] = []
    for (const node of nodes) {
      if (node.type === 'choice') { out.push({ ...node, content: decode(node.content ?? []) }); continue }
      const end = offset + node.text.length
      for (const run of runs(offset, end)) {
        if (run.hidden) continue
        const marks: MarkJSON[] = [...(node.marks?.filter(mark => mark.type === 'origin') ?? [])]
        for (const type of run.marks) marks.push({ type })
        out.push({ type: 'text', text: source.slice(run.from, run.to), ...(marks.length ? { marks } : {}) })
      }
      offset = end
    }
    return out
  }
  block.content = decode(content)
  block.markdown = { content }
  return block
}

function importedMarkdown(source: string): Manuscript {
  const blocks: BlockJSON[] = []
  // Keep multiline paragraphs and fenced code intact. List items and quoted
  // paragraphs remain individually editable, with their original prefixes.
  const ends: number[] = []
  markdownParser.parse(source).iterate({ enter(node) {
    if (node.type.is('LeafBlock')) { ends.push(node.to); return false }
  } })
  let from = 0
  for (const to of ends) {
    const text = source.slice(from, to)
    const content: InlineJSON[] = text ? [{ type: 'text', text }] : []
    const block = readMarkdownBlock(content, crypto.randomUUID())
    const separator = /^(?:[ \t]*\n)+/.exec(source.slice(to))?.[0] ?? ''
    block.markdown!.separator = separator
    blocks.push(block)
    from = to + separator.length
  }
  if (blocks.length && from < source.length) blocks.at(-1)!.markdown!.separator += source.slice(from)
  return { type: 'doc', content: blocks.length ? blocks : [readMarkdownBlock(source ? [{ type: 'text', text: source }] : [], crypto.randomUUID())] }
}
export function ebookHTML(doc: Manuscript, title: string) {
  const first = doc.content[0]
  const titleHeading = first?.type === 'heading' && first.attrs.level === 1 ? '' : '<h1 class="tinto-book-title">' + xml(title) + '</h1>'
  return titleHeading + documentHTML(doc)
}
export function standaloneHTML(doc: Manuscript, title: string) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="generator" content="Tinto"><title>' + xml(title) + '</title><style>' + printStyles + '</style></head><body>' + documentHTML(doc) + '</body></html>'
}
// A post carries the chosen wording only. Blank paragraphs are spacing in a
// manuscript, not content, so the site never receives empty elements.
export function postHTML(blocks: BlockJSON[]): string {
  return postParts(blocks).map(part => part.html).join('\n')
}
export type CharacterOrigins = { written: number; pasted: number; imported: number; ai: number }
// Each paragraph or heading of a post, with how many of its characters came from where.
export function postParts(blocks: BlockJSON[]): { html: string; characters: CharacterOrigins }[] {
  return blocks.filter(block => activeRuns(block.content ?? []).some(run => run.text.trim())).map(block => {
    const characters: CharacterOrigins = { written: 0, pasted: 0, imported: 0, ai: 0 }
    for (const run of activeRuns(block.content ?? [])) characters[originOf(run.marks) ?? 'written'] += [...run.text].length
    return { html: blockHTML(block, ''), characters }
  })
}
export function writeDocx(doc: Manuscript): Uint8Array {
  const paragraphs = doc.content.map(block => {
    const style = block.type === 'heading' ? '<w:pPr><w:pStyle w:val="Heading' + block.attrs.level + '"/></w:pPr>' : ''
    const runs = activeRuns(block.content ?? []).map(run => {
      const marks = formatMarks(run.marks).map(mark => ({ strong: '<w:b/>', em: '<w:i/>', highlight: '<w:u w:val="single"/>' })[mark.type]).join('')
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
function readODT(bytes: Uint8Array): ImportedFile {
  const ns = 'urn:oasis:names:tc:opendocument:xmlns:'
  const textNS = ns + 'text:1.0', styleNS = ns + 'style:1.0', officeNS = ns + 'office:1.0', foNS = ns + 'xsl-fo-compatible:1.0'
  const files = unzipSync(bytes, { filter: file => ['content.xml', 'styles.xml'].includes(file.name) })
  const parse = (name: string) => files[name] && new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml')
  const content = parse('content.xml')
  const body = content?.getElementsByTagNameNS(officeNS, 'text')[0]
  if (!body) throw Error('Choose an unencrypted OpenDocument text file.')

  const styles = new Map<string, Element>()
  for (const doc of [parse('styles.xml'), content]) {
    for (const style of doc?.getElementsByTagNameNS(styleNS, 'style') ?? []) {
      styles.set(style.getAttributeNS(styleNS, 'family') + '/' + style.getAttributeNS(styleNS, 'name'), style)
    }
  }
  // A named style can inherit its bold, italic and underline independently.
  function styledMarks(el: Element, family: string, inherited: MarkJSON[]) {
    const name = el.getAttributeNS(textNS, 'style-name')
    if (!name) return inherited
    const chain: Element[] = []
    let style = styles.get(family + '/' + name)
    while (style && !chain.includes(style)) {
      chain.unshift(style)
      style = styles.get(family + '/' + style.getAttributeNS(styleNS, 'parent-style-name'))
    }
    const marks = new Set(formatMarks(inherited).map(mark => mark.type))
    for (const style of chain) {
      const props = style.getElementsByTagNameNS(styleNS, 'text-properties')[0]
      if (!props) continue
      const weight = props.getAttributeNS(foNS, 'font-weight')
      const italic = props.getAttributeNS(foNS, 'font-style')
      const underline = props.getAttributeNS(styleNS, 'text-underline-style')
      if (weight) { if (weight === 'bold' || Number(weight) >= 600) marks.add('strong'); else marks.delete('strong') }
      if (italic) { if (italic === 'italic' || italic === 'oblique') marks.add('em'); else marks.delete('em') }
      if (underline) { if (underline === 'none') marks.delete('highlight'); else marks.add('highlight') }
    }
    return [...marks].map(type => ({ type }))
  }
  const blocks: BlockJSON[] = []
  function readParagraph(p: Element) {
    const level = Number(p.getAttributeNS(textNS, 'outline-level')) || 1
    let block = newBlock('', p.localName === 'h' ? Math.min(6, level) : undefined)
    blocks.push(block)
    function append(text: string, marks: MarkJSON[]) {
      if (text) (block.content ??= []).push({ type: 'text', text, marks })
    }
    function readInlines(parent: Element, marks: MarkJSON[]) {
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { append(node.textContent ?? '', marks); continue }
        if (!(node instanceof Element) || node.namespaceURI !== textNS) continue
        switch (node.localName) {
          case 's': append(' '.repeat(Number(node.getAttributeNS(textNS, 'c')) || 1), marks); break
          case 'tab': append('\t', marks); break
          case 'line-break': block = newBlock(); blocks.push(block); break
          case 'note': break
          default: readInlines(node, styledMarks(node, 'text', marks))
        }
      }
    }
    readInlines(p, styledMarks(p, 'paragraph', []))
  }
  function visit(parent: Element) {
    for (const el of parent.children) {
      if (el.namespaceURI === textNS && (el.localName === 'p' || el.localName === 'h')) readParagraph(el)
      else if (![ns + 'drawing:1.0', officeNS].includes(el.namespaceURI ?? '') && el.localName !== 'tracked-changes') visit(el)
    }
  }
  visit(body)
  return { manuscript: { type: 'doc', content: blocks.length ? blocks : [newBlock()] }, notes: [] }
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
  if (file.convertedToHTML || extension === 'html' || extension === 'htm') {
    const { manuscriptFromHTML } = await import('./editor')
    let manuscript = manuscriptFromHTML(new TextDecoder().decode(file.bytes), extension === 'epub')
    if (file.markdownSource !== undefined) {
      const original = importedMarkdown(file.markdownSource.replace(/\r\n?/g, '\n'))
      // Keep the converter's rich rendering when the source blocks line up.
      // A compound Markdown block can expand to several rich paragraphs.
      if (original.content.length === manuscript.content.length && original.content.every((block, index) => block.type === manuscript.content[index].type)) {
        manuscript.content.forEach((block, index) => { block.markdown = original.content[index].markdown })
      } else manuscript = original
    }
    return { manuscript, notes: [] }
  }
  if (extension === 'docx') return readDocx(file.bytes)
  if (extension === 'odt') return readODT(file.bytes)
  if (extension === 'pdf') return readPDF(file.bytes)
  if (extension !== 'txt') throw Error('Choose a supported manuscript file.')
  return { manuscript: { type: 'doc', content: new TextDecoder().decode(file.bytes).split(/\r\n?|\n/).map(line => newBlock(line)) }, notes: [] }
}
