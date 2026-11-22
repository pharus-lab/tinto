import { DOMParser as ManuscriptParser, DOMSerializer, Fragment, Schema, Slice, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Command, type Selection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { copyInlines, markTags, newBlock, visibleText, type BlockJSON, type ChoiceJSON, type InlineJSON, type Manuscript, type OptionJSON, type TextJSON } from "./model";
import { diffChars } from "diff";
import { spellingKey } from "./spelling";
import { markdownFormatting, markdownInlines, readMarkdownBlock } from "./exchange";
import { findSection, linkedSection, sectionKey } from "./section";

const parseUnderline = (value: string): null | false => value.split(/\s+/).includes("underline") ? null : false;

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block", content: "inline*", attrs: { id: { default: null }, sourceGap: { default: null } },
      parseDOM: [{ tag: "p" }], toDOM: node => ["p", { "data-block-id": node.attrs.id }, 0],
    },
    heading: {
      group: "block", content: "inline*", defining: true, attrs: { id: { default: null }, level: { default: 1 }, sourceGap: { default: null } },
      parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: "h" + level, attrs: { level } })),
      toDOM: node => ["h" + node.attrs.level, { "data-block-id": node.attrs.id }, 0],
    },
    text: { group: "inline" },
    choice: {
      group: "inline", inline: true, content: "inline*", isolating: true, selectable: false,
      attrs: { id: {}, active: {}, options: {} },
      toDOM: node => ["span", { class: "wording", "data-choice-id": node.attrs.id }, 0],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight", getAttrs: value => value === "bold" || Number(value) >= 600 ? null : false }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }], toDOM: () => ["em", 0] },
    highlight: {
      parseDOM: [{ tag: "u" }, { tag: "mark" }, { style: "text-decoration", getAttrs: parseUnderline }, { style: "text-decoration-line", getAttrs: parseUnderline }],
      toDOM: () => [markTags.highlight, 0],
    },
    // Text the writer did not type here. Not parsed from HTML, so pasted
    // markup cannot claim an origin; typing beside it is unmarked.
    origin: {
      attrs: { source: { default: "pasted" } }, inclusive: false,
      toDOM: mark => ["span", { "data-origin": mark.attrs.source }, 0],
    },
  },
});

export function manuscriptFromHTML(html: string, ebook: boolean): Manuscript {
  // Template contents stay inert, including scripts, images and external styles.
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  const fromTinto = !!content.querySelector('meta[name="generator"][content="Tinto"]');
  content.querySelectorAll("head, title, meta, link, base, style, script, noscript, template, iframe, object, svg, [hidden]").forEach(el => el.remove());
  if (ebook) {
    content.querySelectorAll("h1.tinto-book-title").forEach(el => el.remove());
    for (const anchor of content.querySelectorAll("p > span[id]:only-child:empty")) {
      if (!anchor.parentElement!.textContent?.trim()) anchor.parentElement!.remove();
    }
  }
  for (const cell of content.querySelectorAll("td, th")) {
    const block = cell.ownerDocument.createElement("div");
    block.append(...cell.childNodes);
    cell.replaceWith(block);
  }
  for (const p of content.querySelectorAll("p")) {
    if (p.textContent === "\u00a0") p.replaceChildren();
  }
  for (const br of content.querySelectorAll("br")) {
    if (br.parentNode?.childNodes.length === 1 && br.parentElement?.matches("p, h1, h2, h3, h4, h5, h6")) br.remove();
    else br.replaceWith("\u2028");
  }
  const parser = ManuscriptParser.fromSchema(schema);
  // Our HTML uses pre-wrap within paragraphs. Parse the blocks separately so
  // whitespace between tags never becomes part of the manuscript.
  const parsed = fromTinto ? [...content.querySelectorAll("p,h1,h2,h3,h4,h5,h6")].map(el => {
    const wrapper = document.createElement("template");
    wrapper.content.append(el);
    return parser.parse(wrapper.content, { preserveWhitespace: "full" });
  }) : [parser.parse(content)];
  const blocks: BlockJSON[] = [];
  for (const doc of parsed) doc.forEach(node => {
    let block = newBlock("", node.type === schema.nodes.heading ? node.attrs.level : undefined);
    blocks.push(block);
    node.forEach(run => {
      const json: TextJSON = run.toJSON();
      for (const [index, text] of json.text.split("\u2028").entries()) {
        if (index) { block = newBlock(); blocks.push(block); }
        if (text) (block.content ??= []).push({ ...json, text });
      }
    });
  });
  if (ebook && !blocks.some(block => visibleText(block).trim())) throw Error("This EPUB has no readable text. Choose a text-based, DRM-free EPUB.");
  return { type: "doc", content: blocks.length ? blocks : [newBlock()] };
}

// Pasted or dropped text from outside Tinto is marked as pasted. Moving text
// within the manuscript, and Tinto's own clipboard, keep the origin it had.
function markPasted(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach(node => {
    if (node.isText) nodes.push(node.mark(schema.marks.origin.create({ source: "pasted" }).addToSet(node.marks)));
    else nodes.push(node.copy(markPasted(node.content)));
  });
  return Fragment.from(nodes);
}
// Typed text is the writer's own, even inside a pasted passage.
function asWritten(tr: Transaction, from: number, to: number): Transaction {
  return tr.doc.rangeHasMark(from, to, schema.marks.origin) ? tr.removeMark(from, to, schema.marks.origin) : tr;
}

export interface ChoiceContext {
  id: string;
  active: string;
  options: { id: string; text: string; content: InlineJSON[] }[];
  parentId: string | null;
  parentText: string | null;
  children: { id: string; text: string }[];
}

export interface EditorHooks {
  change?(doc: Manuscript): void;
  selection?(): void;
  message?(message: string): void;
  plugins?: Plugin[];
}

type LocatedChoice = { node: PMNode; pos: number };
export type Format = "bold" | "italic" | "underline" | "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function enclosingChoice(position: ResolvedPos): LocatedChoice | null {
  for (let depth = position.depth; depth > 0; depth--) {
    const node = position.node(depth);
    if (node.type === schema.nodes.choice) return { node, pos: position.before(depth) };
  }
  return null;
}

function locate(doc: PMNode, id: string): LocatedChoice | null {
  let found: LocatedChoice | null = null;
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.choice && node.attrs.id === id) found = { node, pos };
    return !found;
  });
  return found;
}

function partialGroup(selection: Selection): boolean {
  return enclosingChoice(selection.$from)?.pos !== enclosingChoice(selection.$to)?.pos;
}

// A mouse range can end inside a span just after its final letter, even
// though the writer selected the complete group. Lift only those edges
// needed to reach the same inline parent, retaining the smallest such range.
function wordingRange(selection: Selection): { start: ResolvedPos; end: ResolvedPos } | null {
  let start = selection.$from;
  let end = selection.$to;
  if (start.depth === 0 && end.depth === 0 && start.doc.childCount === 1 && start.pos === 0 && end.pos === start.doc.content.size) {
    start = start.doc.resolve(1);
    end = end.doc.resolve(end.pos - 1);
  }
  while (!start.sameParent(end)) {
    if (start.depth >= end.depth && start.parent.type === schema.nodes.choice && start.parentOffset === 0) {
      start = start.doc.resolve(start.before());
    } else if (end.depth >= start.depth && end.parent.type === schema.nodes.choice && end.parentOffset === end.parent.content.size) {
      end = end.doc.resolve(end.after());
    } else {
      return null;
    }
  }
  return start.parent.inlineContent ? { start, end } : null;
}

const selectionMessage = "Select wording within one paragraph. Include each alternative in full, or select text inside one option.";
const splitMessage = "Keep this wording in one paragraph. Press Alt/Option + → to move outside the alternative, then start a new paragraph.";
const passageMime = "application/x-tinto-passage+json";
const markdownMime = "application/x-tinto-markdown+json";

function transferRange(selection: Selection, includeWholeChoice: boolean) {
  let start = selection.$from;
  let end = selection.$to;
  const shared = start.sharedDepth(end.pos);
  while (start.depth > shared && start.parent.type === schema.nodes.choice) {
    if (start.parentOffset !== 0) return null;
    start = start.doc.resolve(start.before());
  }
  while (end.depth > shared && end.parent.type === schema.nodes.choice) {
    if (end.parentOffset !== end.parent.content.size) return null;
    end = end.doc.resolve(end.after());
  }
  while (includeWholeChoice && start.sameParent(end) && start.parent.type === schema.nodes.choice && start.parentOffset === 0 && end.parentOffset === end.parent.content.size) {
    start = start.doc.resolve(start.before());
    end = end.doc.resolve(end.after());
  }
  return { start, end };
}

function readPassage(raw: string): Slice | null {
  if (!raw) return null;
  try {
    const input = Slice.fromJSON(schema, JSON.parse(raw));
    const content: PMNode[] = [];
    input.content.forEach(node => {
      node.check();
      const json = node.toJSON();
      if (node.isInline) content.push(schema.nodeFromJSON(copyInlines([json])[0]));
      else if (node.isTextblock) content.push(node.type.create({ ...node.attrs, id: null }, Fragment.fromJSON(schema, copyInlines(json.content ?? []))));
      else throw Error("Unsupported clipboard content");
    });
    return new Slice(Fragment.from(content), input.openStart, input.openEnd);
  } catch { return null; }
}

function writePassage(view: EditorView, event: ClipboardEvent, notice: (text: string) => void, markdown: boolean): boolean {
  const { state } = view;
  if (state.selection.empty || !event.clipboardData) return false;
  event.preventDefault();
  const range = transferRange(state.selection, true);
  if (!range) { notice(selectionMessage); return true; }
  const { start, end } = range;
  const slice = state.doc.slice(start.pos, end.pos);
  const html = document.createElement("div");
  html.append(DOMSerializer.fromSchema(schema).serializeFragment(slice.content));
  for (const span of html.querySelectorAll("[data-choice-id]")) span.replaceWith(...span.childNodes);
  for (const block of html.querySelectorAll("[data-block-id]")) block.removeAttribute("data-block-id");
  let plain = slice.content.textBetween(0, slice.content.size, "\n");
  if (markdown && slice.content.firstChild?.isBlock) {
    plain = "";
    slice.content.forEach((block, _pos, index) => {
      plain += block.textContent;
      if (index < slice.content.childCount - 1) plain += block.attrs.sourceGap || "\n\n";
    });
  }
  event.clipboardData.setData("text/plain", plain);
  if (!markdown) event.clipboardData.setData("text/html", html.innerHTML);
  event.clipboardData.setData(markdown ? markdownMime : passageMime, JSON.stringify(slice.toJSON()));
  if (event.type === "cut") view.dispatch(closeHistory(state.tr.deleteRange(start.pos, end.pos)).setMeta("uiEvent", "cut").scrollIntoView());
  return true;
}

function blockIdentifiers(): Plugin {
  return new Plugin({
    appendTransaction(transactions, old, state) {
      if (!transactions.some(tr => tr.docChanged)) return null;
      const ids = new Set<string>();
      const tr = state.tr;
      // Enter or a multi-paragraph paste at the very start moves the
      // existing paragraph after new material. Its text keeps its identity.
      let movedBlock: { id: string; pos: number } | null = null;
      const { $from, empty } = old.selection;
      if (state.doc.childCount > old.doc.childCount && empty && $from.depth === 1 && $from.parentOffset === 0 && $from.parent.content.size > 0) {
        const mappedPos = transactions.reduce((pos, change) => change.mapping.map(pos), $from.pos);
        const mapped = state.doc.resolve(mappedPos);
        if (mapped.parent.type === $from.parent.type && mapped.before() !== $from.before() &&
            (!mapped.parent.attrs.id || mapped.parent.attrs.id === $from.parent.attrs.id) && mapped.parent.content.cut(mapped.parentOffset).eq($from.parent.content)) {
          movedBlock = { id: $from.parent.attrs.id, pos: mapped.before() };
        }
      }
      state.doc.forEach((block, pos) => {
        let id = movedBlock?.pos === pos ? movedBlock.id : block.attrs.id;
        if (!id || ids.has(id) || (movedBlock && id === movedBlock.id && pos !== movedBlock.pos)) id = crypto.randomUUID();
        if (id !== block.attrs.id) tr.setNodeMarkup(pos, undefined, { ...block.attrs, id });
        ids.add(id);
      });
      return tr.docChanged ? tr : null;
    },
  });
}

function headingPreview(block: PMNode) {
  const { runs } = markdownFormatting(block.textContent);
  const spans: { from: number; to: number; className: string }[] = [];
  let offset = 0;
  block.descendants((node, pos) => {
    if (!node.isText) return;
    // Markdown offsets count characters. Editor positions also count choice boundaries.
    const end = offset + node.nodeSize;
    for (const run of runs(offset, end)) {
      const className = run.hidden ? "markdown-marker" : run.marks.map(type => "markdown-" + markTags[type]).join(" ");
      if (className) spans.push({ from: pos + run.from - offset, to: pos + run.to - offset, className });
    }
    offset = end;
  });
  return spans;
}

export class WritingEditor {
  markdown = false;
  private otherState?: EditorState;
  private readonly sourceByRich = new WeakMap<PMNode, { node: PMNode; authored: boolean }>();
  private readonly richBySource = new WeakMap<PMNode, PMNode>();
  private readonly headingPreviews = new WeakMap<PMNode, ReturnType<typeof headingPreview>>();
  readonly view: EditorView;
  private reviewId: string | null = null;
  private hooks: EditorHooks;

  constructor(host: HTMLElement, doc: Manuscript, hooks: EditorHooks = {}) {
    this.hooks = hooks;
    const initial = schema.nodeFromJSON(doc);
    initial.forEach((rich, _pos, index) => {
      const source = doc.content[index].markdown;
      if (!source) return;
      const node = rich.type.create({ ...rich.attrs, sourceGap: source.separator }, Fragment.fromJSON(schema, source.content));
      this.sourceByRich.set(rich, { node, authored: true });
      this.richBySource.set(node, rich);
    });
    // Source blocks retain their identity as the writer changes the heading prefix.
    const markdownHeadings = new Plugin({ appendTransaction: (transactions, _old, state) => {
      if (!this.markdown || !transactions.some(tr => tr.docChanged)) return null;
      const tr = state.tr;
      state.doc.forEach((node, pos) => {
        const rich = this.richBlock(node);
        if (rich.type !== node.type || rich.attrs.level !== node.attrs.level) tr.setNodeMarkup(pos, rich.type, { ...rich.attrs, sourceGap: node.attrs.sourceGap });
      });
      return tr.docChanged ? tr : null;
    } });
    const bindings: Record<string, Command> = {
      "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo,
      "Mod-b": () => this.format("bold"), "Mod-i": () => this.format("italic"), "Mod-u": () => this.format("underline"),
      "Alt-ArrowRight": () => this.leaveChoice(),
      "ArrowLeft": () => this.crossChoiceBoundary(-1), "ArrowRight": () => this.crossChoiceBoundary(1),
      "Backspace": () => this.deleteAtBoundary(-1), "Delete": () => this.deleteAtBoundary(1),
    };

    this.view = new EditorView(host, {
      state: EditorState.create({
        schema, doc: initial,
        plugins: [history(), blockIdentifiers(), markdownHeadings, linkedSection(hooks.message), keymap(bindings), keymap(baseKeymap), ...(hooks.plugins ?? [])],
      }),
      attributes: () => ({ role: "textbox", "aria-label": this.markdown ? "Markdown source" : "Manuscript", class: this.markdown ? "markdown-source" : "", "aria-multiline": "true", spellcheck: "false" }),
      decorations: state => {
        const found = this.reviewId ? locate(state.doc, this.reviewId) : enclosingChoice(state.selection.$from);
        const ranges: Decoration[] = [];
        if (found) ranges.push(Decoration.node(found.pos, found.pos + found.node.nodeSize, { class: "reviewed-wording" }));
        if (this.markdown) {
          const { $from, to } = state.selection;
          const current = $from.sharedDepth(to) > 0 ? $from.node(1) : null;
          state.doc.forEach((block, pos) => {
            const gap: string | null = block.attrs.sourceGap;
            if (gap !== null) ranges.push(Decoration.node(pos, pos + block.nodeSize, { style: "--markdown-gap: " + Math.max(0, gap.split("\n").length - 2) + "lh" }));
            if (block.type !== schema.nodes.heading) return;
            if (block === current) ranges.push(Decoration.node(pos, pos + block.nodeSize, { class: "markdown-current-heading" }));
            let spans = this.headingPreviews.get(block);
            if (!spans) {
              spans = headingPreview(block);
              this.headingPreviews.set(block, spans);
            }
            for (const span of spans) ranges.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { class: span.className }));
          });
        }
        return ranges.length ? DecorationSet.create(state.doc, ranges) : null;
      },
      handleClick: (view, pos, event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey || !(event.target instanceof Element)) return false;
        const wording = event.target.closest(".wording");
        if (!wording) return false;
        // A click in a span's padding belongs inside that wording, even
        // when Chromium reports the equivalent position in its parent.
        const start = view.posAtDOM(wording, 0);
        const end = view.posAtDOM(wording, wording.childNodes.length);
        const caret = Math.max(start, Math.min(pos, end));
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)).setMeta("pointer", true));
        return true;
      },
      handleKeyDown: (view, event) => {
        const selection = view.state.selection;
        if (event.key === "Enter" && (enclosingChoice(selection.$from) || enclosingChoice(selection.$to))) return this.explain(splitMessage);
        if (this.markdown && event.key === "Enter" && !event.isComposing) {
          const tr = view.state.tr.deleteSelection();
          const at = tr.selection.$from;
          if (at.depth !== 1) return false;
          tr.split(at.pos, 1, [{ type: schema.nodes.paragraph, attrs: { sourceGap: at.parent.attrs.sourceGap } }]);
          tr.setNodeMarkup(at.before(), undefined, { ...at.parent.attrs, sourceGap: "\n" });
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          if (partialGroup(selection)) return this.explain(selectionMessage);
          if (event.repeat && selection.$from.parent.type === schema.nodes.choice && !selection.$from.parent.content.size) return true;
          if (this.markdown && this.deleteMarkdownBreak(event.key === "Backspace")) return true;
        }
        return false;
      },
      handleTextInput: (view, from, _to, text, typed) => {
        if (partialGroup(view.state.selection)) return this.explain(selectionMessage);
        const tr = typed();
        if (!tr.doc.rangeHasMark(from, from + text.length, schema.marks.origin)) return false;
        view.dispatch(asWritten(tr, from, from + text.length));
        return true;
      },
      transformPasted: (slice, view) => view.dragging ? slice : new Slice(markPasted(slice.content), slice.openStart, slice.openEnd),
      transformPastedHTML: html => {
        // Rich text from other editors may carry their own ProseMirror schema.
        // Parse only prose/marks; Tinto groups travel in the typed clipboard entry.
        const parsed = new DOMParser().parseFromString(html, "text/html");
        for (const node of parsed.querySelectorAll("[data-pm-slice]")) node.removeAttribute("data-pm-slice");
        return parsed.body.innerHTML;
      },
      handlePaste: (view, event, slice) => {
        const selection = view.state.selection;
        const range = transferRange(selection, false);
        if (!range) return this.explain(selectionMessage);
        const internal = readPassage(event.clipboardData?.getData(this.markdown ? markdownMime : passageMime) ?? "");
        let content = internal ?? slice;
        if (this.markdown && !internal) {
          const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
          const paragraphs = text.split("\n").map(line => schema.nodes.paragraph.create({ sourceGap: "\n" }, line ? schema.text(line) : null));
          content = Slice.maxOpen(markPasted(Fragment.fromArray(paragraphs)));
        }
        const multipleLines = (content.content.firstChild?.isBlock && content.content.childCount > 1) || /[\r\n]/.test(event.clipboardData?.getData("text/plain") ?? "");
        if (enclosingChoice(range.start)) {
          if (multipleLines) return this.explain(splitMessage);
          if (content.content.childCount === 1 && content.content.firstChild!.isTextblock) content = new Slice(content.content.firstChild!.content, 0, 0);
        }
        if (!this.markdown && !internal && range.start.pos === selection.from && range.end.pos === selection.to) return false;
        const tr = view.state.tr;
        if (range.start.pos !== selection.from || range.end.pos !== selection.to) tr.setSelection(TextSelection.create(tr.doc, range.start.pos, range.end.pos));
        tr.replaceSelection(content);
        if (this.markdown && content.content.childCount > 1 && content.content.firstChild?.isBlock) {
          const start = tr.doc.resolve(0).posAtIndex(range.start.index(0));
          tr.setNodeAttribute(start, "sourceGap", content.content.firstChild.attrs.sourceGap);
          const last = tr.selection.$to;
          if (last.depth) tr.setNodeAttribute(last.before(1), "sourceGap", range.end.depth ? range.end.node(1).attrs.sourceGap : null);
        }
        view.dispatch(closeHistory(tr).setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        copy: (view, event) => writePassage(view, event, message => this.explain(message), this.markdown),
        cut: (view, event) => writePassage(view, event, message => this.explain(message), this.markdown),
        beforeinput: (view, event) => {
          const selection = view.state.selection;
          const split = ["insertParagraph", "insertLineBreak"].includes(event.inputType);
          if (split && enclosingChoice(selection.$from)) {
            event.preventDefault();
            return this.explain(splitMessage);
          }
          if (partialGroup(selection)) {
            event.preventDefault();
            return this.explain(selectionMessage);
          }
          // Chromium removes the enclosing span when its last grapheme is
          // deleted. Use its intended text range, but keep the choice node.
          const { $from } = selection;
          if (event.cancelable && !event.isComposing && $from.parent.type === schema.nodes.choice && /^delete.*(Backward|Forward)$/.test(event.inputType)) {
            const range = event.getTargetRanges()[0];
            if (range) {
              const from = Math.max($from.start(), view.posAtDOM(range.startContainer, range.startOffset));
              const to = Math.min($from.end(), view.posAtDOM(range.endContainer, range.endOffset));
              event.preventDefault();
              if (from < to) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
              else if (!$from.parent.content.size) this.deleteAtBoundary(event.inputType.endsWith("Backward") ? -1 : 1);
              return true;
            }
          }
          // Replacing a span's entire text through Chromium's native input
          // method can remove the span itself. Write at the model selection
          // so its containing choice and its inactive options stay intact.
          if (event.inputType === "insertText" && event.cancelable && !event.isComposing && event.data !== null && enclosingChoice(selection.$from)) {
            event.preventDefault();
            const from = selection.from;
            view.dispatch(asWritten(view.state.tr.insertText(event.data), from, from + event.data.length).scrollIntoView());
            return true;
          }
          return false;
        },
      },
      dispatchTransaction: transaction => {
        const previous = this.view.state;
        const next = previous.apply(transaction);
        this.view.updateState(next);
        if (next.doc !== previous.doc) hooks.change?.(this.json());
        if (next.doc !== previous.doc || !previous.selection.eq(next.selection) || previous.storedMarks !== next.storedMarks) hooks.selection?.();
        // Chromium treats the parent position beside an empty span as an
        // equivalent caret position. Keep the visible caret inside the box.
        const { empty, $from } = next.selection;
        if (empty && $from.parent.type === schema.nodes.choice && !$from.parent.content.size && this.view.hasFocus()) {
          const box = this.view.nodeDOM($from.before());
          const selection = this.view.dom.ownerDocument.getSelection();
          if (box && selection && selection.anchorNode !== box) selection.collapse(box, 0);
        }
      },
    });
  }

  private explain(message: string): true {
    this.hooks.message?.(message);
    return true;
  }

  private deleteMarkdownBreak(backward: boolean): boolean {
    const { state } = this.view;
    const { empty, $from } = state.selection;
    if (!empty || $from.depth !== 1 || $from.parentOffset !== (backward ? 0 : $from.parent.content.size)) return false;
    const right = $from.index(0) + (backward ? 0 : 1);
    if (!right || right >= state.doc.childCount) return false;
    const leftPos = $from.posAtIndex(right - 1, 0), boundary = $from.posAtIndex(right, 0);
    const left = state.doc.child(right - 1), next = state.doc.child(right);
    const gap: string = left.attrs.sourceGap || "\n\n";
    const tr = state.tr;
    if (gap.length > 1) tr.setNodeAttribute(leftPos, "sourceGap", backward ? gap.slice(0, -1) : gap.slice(1));
    else tr.join(boundary).setNodeAttribute(leftPos, "sourceGap", next.attrs.sourceGap);
    this.view.dispatch(tr.scrollIntoView());
    return true;
  }

  // Inline nodes have an editable inside and an outside position at each end.
  // Chromium can skip one when moving across a span. Move explicitly at these seams.
  private crossChoiceBoundary(direction: number): boolean {
    const { state } = this.view;
    const { empty, $from } = state.selection;
    if (!empty) return false;
    const adjacent = direction < 0 ? $from.nodeBefore : $from.nodeAfter;
    const atEdge = direction < 0 ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
    if (adjacent?.type !== schema.nodes.choice && !(atEdge && $from.parent.type === schema.nodes.choice)) return false;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.pos + direction)));
    return true;
  }

  private deleteAtBoundary(direction: number): boolean {
    const { state } = this.view;
    const { $from, empty } = state.selection;
    if (empty && $from.parent.type === schema.nodes.choice && !$from.parent.content.size) {
      this.commitChoice(state.tr.delete($from.before(), $from.after()));
      return true;
    }
    return this.crossChoiceBoundary(direction);
  }

  private leaveChoice(): boolean {
    const { state } = this.view;
    let group = enclosingChoice(state.selection.$from);
    if (!group) return false;
    let end = group.pos + group.node.nodeSize;
    while ((group = enclosingChoice(state.doc.resolve(end)))) end = group.pos + group.node.nodeSize;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)).scrollIntoView());
    return true;
  }

  private sourceBlock(rich: PMNode): PMNode {
    const known = this.sourceByRich.get(rich);
    if (known) return known.node;
    const node = rich.copy(Fragment.fromJSON(schema, markdownInlines(rich.toJSON())));
    this.sourceByRich.set(rich, { node, authored: false });
    this.richBySource.set(node, rich);
    return node;
  }

  private richBlock(source: PMNode): PMNode {
    const known = this.richBySource.get(source);
    if (known) return known;
    const block = readMarkdownBlock(source.content.toJSON() ?? [], source.attrs.id);
    const rich = schema.nodeFromJSON(block);
    this.richBySource.set(source, rich);
    this.sourceByRich.set(rich, { node: source, authored: true });
    return rich;
  }

  setMarkdown(enabled: boolean) {
    if (enabled === this.markdown) return;
    const previous = this.view.state;
    const section = sectionKey.getState(previous);
    const blocks: PMNode[] = [];
    previous.doc.forEach(node => blocks.push(enabled ? this.sourceBlock(node) : this.richBlock(node)));
    this.markdown = enabled;
    const doc = schema.nodes.doc.create(null, blocks);
    let next = this.otherState ?? EditorState.create({ schema, doc, plugins: previous.plugins });
    this.otherState = previous;
    if (sectionKey.getState(next)) next = next.apply(next.tr.setMeta(sectionKey, null));
    if (!next.doc.eq(doc)) {
      // Only changed blocks enter the other view's undo history. Merely
      // switching views leaves the existing document and undo stack intact.
      let first = 0, last = next.doc.childCount, end = blocks.length;
      while (first < last && first < end && next.doc.child(first).eq(blocks[first])) first++;
      while (last > first && end > first && next.doc.child(last - 1).eq(blocks[end - 1])) { last--; end--; }
      const from = next.doc.resolve(0).posAtIndex(first), to = next.doc.resolve(0).posAtIndex(last);
      next = next.apply(closeHistory(next.tr.replaceWith(from, to, Fragment.fromArray(blocks.slice(first, end)))));
    }
    if (!enabled) next.doc.forEach((rich, _pos, index) => {
      const source = previous.doc.child(index);
      this.sourceByRich.set(rich, { node: source, authored: this.sourceByRich.get(blocks[index])?.authored ?? false });
      this.richBySource.set(source, rich);
    });
    const position = (old: ResolvedPos) => {
      const index = Math.min(old.index(0), next.doc.childCount - 1);
      const start = next.doc.resolve(0).posAtIndex(index);
      const offset = old.depth ? old.pos - old.start(1) : 0;
      // Each side of an inline choice occupies a ProseMirror position.
      const text = (node: PMNode): string => node.text ?? node.children.map(child => child.isText ? child.text : "\ufffc" + text(child) + "\ufffc").join("");
      let before = 0, after = 0;
      for (const part of diffChars(text(previous.doc.child(index)), text(next.doc.child(index)))) {
        if (part.added) { after += part.value.length; continue; }
        if (offset <= before + part.value.length) return start + 1 + after + (part.removed ? 0 : offset - before);
        before += part.value.length;
        if (!part.removed) after += part.value.length;
      }
      return start + 1 + after;
    };
    const selection = TextSelection.create(next.doc, position(previous.selection.$anchor), position(previous.selection.$head));
    const selectionTr = next.tr.setSelection(selection).setMeta(sectionKey, section?.id ?? null).setMeta("addToHistory", false);
    const checker = spellingKey.getState(previous)?.checker;
    if (checker && checker !== spellingKey.getState(next)?.checker) selectionTr.setMeta(spellingKey, checker);
    next = next.apply(selectionTr);
    this.view.updateState(next);

  }

  json(): Manuscript {
    const content: BlockJSON[] = [];
    this.view.state.doc.forEach(node => {
      const rich = this.markdown ? this.richBlock(node) : node;
      const block: BlockJSON = rich.toJSON();
      block.attrs = block.type === "heading" ? { id: rich.attrs.id, level: rich.attrs.level } : { id: rich.attrs.id };
      const source = this.sourceByRich.get(rich);
      if (source?.authored) block.markdown = { content: source.node.content.toJSON() ?? [], separator: source.node.attrs.sourceGap ?? undefined };
      content.push(block);
    });
    return { type: "doc", content };
  }

  jumpToHeading(id: string) {
    const { state } = this.view;
    const section = findSection(state.doc, id);
    if (!section) return;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, section.from + 1)));
    this.view.focus();
    const heading = this.view.nodeDOM(section.from);
    if (heading instanceof HTMLElement) heading.scrollIntoView({ block: "start", inline: "nearest" });
  }

  showSection(headingId: string | null): boolean {
    const { state } = this.view;
    const section = headingId && findSection(state.doc, headingId);
    if (headingId && !section) return false;
    if ((sectionKey.getState(state)?.id ?? null) === headingId) return true;
    const tr = state.tr.setMeta(sectionKey, headingId).setMeta("addToHistory", false);
    if (section) tr.setSelection(TextSelection.create(state.doc, section.from + 1));
    this.view.dispatch(tr);
    return true;
  }

  private visibleChoice(id: string): LocatedChoice | null {
    const { state } = this.view;
    const choice = locate(state.doc, id);
    const section = sectionKey.getState(state);
    if (choice && section && (choice.pos < section.from || choice.pos >= section.to)) return null;
    return choice;
  }

  context(groupId?: string): ChoiceContext | null {
    const { doc, selection } = this.view.state;
    const found = groupId ? this.visibleChoice(groupId) : enclosingChoice(selection.$from);
    if (!found) return null;
    const { node, pos } = found;
    const { id, active, options } = node.attrs as ChoiceJSON["attrs"];
    const parent = enclosingChoice(doc.resolve(pos));
    const children: ChoiceContext["children"] = [];
    node.forEach(child => {
      if (child.type === schema.nodes.choice) children.push({ id: child.attrs.id, text: child.textContent });
    });
    return {
      id, active,
      options: options.map(option => {
        const content: InlineJSON[] = option.id === active ? node.content.toJSON() ?? [] : option.content ?? [];
        return { id: option.id, text: content.map(visibleText).join(""), content };
      }),
      parentId: parent?.node.attrs.id ?? null, parentText: parent?.node.textContent ?? null, children,
    };
  }

  review(groupId: string | null): void {
    if (this.reviewId === groupId) return;
    this.reviewId = groupId;
    this.view.updateState(this.view.state);
  }

  private applyChoice(tr: Transaction, pos: number, selectText: boolean): void {
    const node = tr.doc.nodeAt(pos)!;
    const end = pos + 1 + node.content.size;
    tr.setSelection(TextSelection.create(tr.doc, selectText ? pos + 1 : end, end));
    this.commitChoice(tr);
  }

  private commitChoice(tr: Transaction): void {
    this.view.dispatch(closeHistory(tr).scrollIntoView());
    this.view.dispatch(closeHistory(this.view.state.tr));
  }

  addAlternative(): string | null {
    const { state } = this.view;
    if (state.selection.empty) {
      this.explain("Select the word or passage you want to try another way.");
      return null;
    }
    const range = wordingRange(state.selection);
    if (!range) {
      this.explain(selectionMessage);
      return null;
    }
    const { start, end } = range;
    if (start.pos === end.pos) {
      this.explain("Select the word or passage you want to try another way.");
      return null;
    }
    const original = start.parent.content.cut(start.parentOffset, end.parentOffset).toJSON() as InlineJSON[];
    const id = crypto.randomUUID();
    const active = crypto.randomUUID();
    const options: OptionJSON[] = [{ id: crypto.randomUUID(), content: original }, { id: active }];
    const node = schema.nodes.choice.create({ id, active, options }, Fragment.fromJSON(schema, copyInlines(original)));
    this.applyChoice(state.tr.replaceWith(start.pos, end.pos, node), start.pos, true);
    this.view.focus();
    return id;
  }

  addOption(groupId: string): string | null {
    const { state } = this.view;
    const found = this.visibleChoice(groupId);
    if (!found) return null;
    const original = found.node.content.toJSON() ?? [];
    const active = crypto.randomUUID();
    const attrs = found.node.attrs as ChoiceJSON["attrs"];
    const options = attrs.options.map(option => option.id === attrs.active ? { id: option.id, content: original } : option);
    options.push({ id: active });
    const node = schema.nodes.choice.create({ ...attrs, active, options }, Fragment.fromJSON(schema, copyInlines(original)));
    this.applyChoice(state.tr.replaceWith(found.pos, found.pos + found.node.nodeSize, node), found.pos, true);
    this.view.focus();
    return active;
  }

  selectOptionText(groupId: string): boolean {
    const { state } = this.view;
    const found = this.visibleChoice(groupId);
    if (!found) return false;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, found.pos + 1, found.pos + found.node.nodeSize - 1)).scrollIntoView());
    this.view.focus();
    return true;
  }

  choose(groupId: string, optionId: string): boolean {
    const { state } = this.view;
    const found = this.visibleChoice(groupId);
    if (!found) return false;
    const attrs = found.node.attrs as ChoiceJSON["attrs"];
    const next = attrs.options.find(option => option.id === optionId);
    if (!next) return false;
    if (attrs.active === optionId) return true;
    const options = attrs.options.map(option => {
      if (option.id === attrs.active) return { id: option.id, content: found.node.content.toJSON() ?? [] };
      return option.id === optionId ? { id: optionId } : option;
    });
    const node = schema.nodes.choice.create({ ...attrs, active: optionId, options }, Fragment.fromJSON(schema, next.content ?? []));
    this.applyChoice(state.tr.replaceWith(found.pos, found.pos + found.node.nodeSize, node), found.pos, false);
    return true;
  }

  editOption(groupId: string, optionId: string, content: InlineJSON[]): void {
    const found = this.visibleChoice(groupId);
    if (!found) return;
    const { node, pos } = found;
    const attrs = node.attrs as ChoiceJSON["attrs"];
    const tr = this.view.state.tr;
    if (attrs.active === optionId) {
      tr.replaceWith(pos + 1, pos + node.nodeSize - 1, Fragment.fromJSON(schema, content));
    } else {
      const options = attrs.options.map(option => option.id === optionId ? { id: optionId, content } : option);
      tr.setNodeAttribute(pos, "options", options);
    }
    this.commitChoice(tr);
  }

  deleteOption(groupId: string, optionId: string): void {
    const found = this.visibleChoice(groupId);
    if (!found) return;
    const { node, pos } = found;
    const attrs = node.attrs as ChoiceJSON["attrs"];
    const index = attrs.options.findIndex(option => option.id === optionId);
    if (index < 0) return;
    const options = attrs.options.filter(option => option.id !== optionId);
    const active = options.find(option => option.id === attrs.active) ?? options[Math.min(index, options.length - 1)];
    const content = active?.id === attrs.active ? node.content : Fragment.fromJSON(schema, active?.content ?? []);
    const tr = this.view.state.tr;
    if (options.length < 2) {
      tr.replaceWith(pos, pos + node.nodeSize, content);
      tr.setSelection(TextSelection.create(tr.doc, pos + content.size));
      this.commitChoice(tr);
    } else {
      const remaining = options.map(option => option.id === active.id ? { id: active.id } : option);
      const updated = node.type.create({ ...attrs, active: active.id, options: remaining }, content, node.marks);
      this.applyChoice(tr.replaceWith(pos, pos + node.nodeSize, updated), pos, false);
    }
  }

  cycle(groupId: string, direction: number): boolean {
    const group = this.context(groupId);
    if (!group) return false;
    const current = group.options.findIndex(option => option.id === group.active);
    const next = (current + direction + group.options.length) % group.options.length;
    return this.choose(groupId, group.options[next].id);
  }

  format(format: Format): boolean {
    if (this.markdown) return true;
    const { state, dispatch } = this.view;
    const { from, to, empty } = state.selection;
    if (partialGroup(state.selection) && !wordingRange(state.selection)) return this.explain(selectionMessage);
    if (format === "paragraph" || /^h[1-6]$/.test(format)) {
      const paragraph = format === "paragraph";
      const type = paragraph ? schema.nodes.paragraph : schema.nodes.heading;
      const attrs = (block: PMNode) => paragraph ? { id: block.attrs.id } : { id: block.attrs.id, level: Number(format.slice(1)) };
      dispatch(state.tr.setBlockType(from, to, type, attrs));
    } else {
      const name = format === "bold" ? "strong" : format === "italic" ? "em" : "highlight";
      const mark = schema.marks[name];
      if (empty) toggleMark(mark)(state, dispatch);
      else {
        const tr = state.tr;
        const remove = state.doc.rangeHasMark(from, to, mark);
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          if (remove) tr.removeMark(start, end, mark);
          else tr.addMark(start, end, mark.create());
        });
        dispatch(tr);
      }
    }
    this.view.focus();
    return true;
  }

  undo(): boolean { return undo(this.view.state, this.view.dispatch); }
  redo(): boolean { return redo(this.view.state, this.view.dispatch); }
  destroy(): void { this.view.destroy(); }
}
