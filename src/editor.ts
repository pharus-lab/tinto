import { Fragment, Schema, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Command, type Selection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { copyInlines, visibleText, type ChoiceJSON, type InlineJSON, type Manuscript, type OptionJSON } from "./model";
import { findSection, linkedSection, sectionKey } from "./section";

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block", content: "inline*", attrs: { id: { default: null } },
      parseDOM: [{ tag: "p" }], toDOM: node => ["p", { "data-block-id": node.attrs.id }, 0],
    },
    heading: {
      group: "block", content: "inline*", defining: true, attrs: { id: { default: null }, level: { default: 1 } },
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
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }], toDOM: () => ["em", 0] },
    highlight: { parseDOM: [{ tag: "mark" }], toDOM: () => ["mark", 0] },
  },
});

export interface ChoiceContext {
  id: string;
  active: string;
  options: { id: string; text: string }[];
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
export type Format = "bold" | "italic" | "highlight" | "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

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

export class WritingEditor {
  readonly view: EditorView;
  private reviewId: string | null = null;
  private hooks: EditorHooks;

  constructor(host: HTMLElement, doc: Manuscript, hooks: EditorHooks = {}) {
    this.hooks = hooks;
    const bindings: Record<string, Command> = {
      "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo,
      "Mod-b": () => this.format("bold"), "Mod-i": () => this.format("italic"),
      "Alt-ArrowRight": () => this.leaveChoice(),
      "ArrowLeft": () => this.crossChoiceBoundary(-1), "ArrowRight": () => this.crossChoiceBoundary(1),
      "Backspace": () => this.crossChoiceBoundary(-1), "Delete": () => this.crossChoiceBoundary(1),
    };

    this.view = new EditorView(host, {
      state: EditorState.create({
        schema, doc: schema.nodeFromJSON(doc),
        plugins: [history(), blockIdentifiers(), linkedSection(hooks.message), keymap(bindings), keymap(baseKeymap), ...(hooks.plugins ?? [])],
      }),
      attributes: { role: "textbox", "aria-label": "Manuscript", "aria-multiline": "true", spellcheck: "false" },
      decorations: state => {
        const found = this.reviewId && locate(state.doc, this.reviewId);
        if (!found) return null;
        return DecorationSet.create(state.doc, [Decoration.node(found.pos, found.pos + found.node.nodeSize, { class: "reviewed-wording" })]);
      },
      handleKeyDown: (view, event) => {
        const selection = view.state.selection;
        if (event.key === "Enter" && (enclosingChoice(selection.$from) || enclosingChoice(selection.$to))) return this.explain(splitMessage);
        if (partialGroup(selection) && (event.key === "Backspace" || event.key === "Delete")) return this.explain(selectionMessage);
        return false;
      },
      handleTextInput: (view) => partialGroup(view.state.selection) && this.explain(selectionMessage),
      handlePaste: (view, event, slice) => {
        const selection = view.state.selection;
        if (partialGroup(selection)) return this.explain(selectionMessage);
        const multipleLines = slice.content.childCount > 1 || /[\r\n]/.test(event.clipboardData?.getData("text/plain") ?? "");
        return !!enclosingChoice(selection.$from) && multipleLines && this.explain(splitMessage);
      },
      handleDOMEvents: {
        cut: (view, event) => {
          if (!partialGroup(view.state.selection)) return false;
          event.preventDefault();
          return this.explain(selectionMessage);
        },
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
          // Replacing a span's entire text through Chromium's native input
          // method can remove the span itself. Write at the model selection
          // so its containing choice and its inactive options stay intact.
          if (event.inputType === "insertText" && event.cancelable && !event.isComposing && event.data !== null && enclosingChoice(selection.$from)) {
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(event.data).scrollIntoView());
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
      },
    });
  }

  private explain(message: string): true {
    this.hooks.message?.(message);
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

  private leaveChoice(): boolean {
    const { state } = this.view;
    let group = enclosingChoice(state.selection.$from);
    if (!group) return false;
    let end = group.pos + group.node.nodeSize;
    while ((group = enclosingChoice(state.doc.resolve(end)))) end = group.pos + group.node.nodeSize;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)).scrollIntoView());
    return true;
  }

  json(): Manuscript {
    return this.view.state.doc.toJSON() as Manuscript;
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
      options: options.map(option => ({ id: option.id, text: option.id === active ? node.textContent : (option.content ?? []).map(visibleText).join("") })),
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

  cycle(groupId: string, direction: number): boolean {
    const group = this.context(groupId);
    if (!group) return false;
    const current = group.options.findIndex(option => option.id === group.active);
    const next = (current + direction + group.options.length) % group.options.length;
    return this.choose(groupId, group.options[next].id);
  }

  format(format: Format): boolean {
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
