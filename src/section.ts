import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { spawnButton } from "./ui";

interface Section {
  id: string;
  from: number;
  to: number;
}

export const sectionKey = new PluginKey<Section | null>("linkedSection");

export function headingSpawns(spawnedIds: () => readonly string[], open: (id: string) => void): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const section = sectionKey.getState(state);
        const spawned = new Set(spawnedIds());
        const controls: Decoration[] = [];
        state.doc.forEach((block, pos) => {
          if (block.type.name !== "heading" || (section && (pos < section.from || pos >= section.to))) return;
          const id = block.attrs.id;
          const title = block.textContent || "Untitled heading";
          const exists = spawned.has(id);
          if (section?.id === id && exists) return;
          controls.push(Decoration.widget(pos + 1 + block.content.size, () => {
            const action = spawnButton(title, exists, () => open(id));
            action.tabIndex = -1; // Keyboard access is provided by the Headings dropdown.
            action.onmousedown = event => event.preventDefault();
            return action;
          }, { side: 1, marks: [], key: JSON.stringify([id, title, exists]), stopEvent: () => true, ignoreSelection: true }));
        });
        return DecorationSet.create(state.doc, controls);
      },
    },
  });
}

export function findSection(doc: Node, id: string): Section | null {
  let section: Section | null = null;
  let level = 0;
  doc.forEach((block, pos) => {
    if (block.type.name !== "heading") return;
    if (block.attrs.id === id) {
      section = { id, from: pos, to: doc.content.size };
      level = block.attrs.level;
    } else if (section && section.to === doc.content.size && block.attrs.level <= level) {
      section.to = pos;
    }
  });
  return section;
}

// Keep one EditorState for the source and all its linked tabs. A view filters
// which blocks are shown, and edits must preserve everything outside its bounds.
export function linkedSection(message?: (text: string) => void): Plugin<Section | null> {
  return new Plugin({
    key: sectionKey,
    state: {
      init: () => null as Section | null,
      apply(tr, previous) {
        const id = tr.getMeta(sectionKey);
        if (id !== undefined) return id ? findSection(tr.doc, id) : null;
        return previous && tr.docChanged ? findSection(tr.doc, previous.id) : previous;
      },
    },
    filterTransaction(tr, state) {
      const section = sectionKey.getState(state);
      if (!tr.docChanged || !section) return true;
      const after = state.doc.content.size - section.to;
      const end = tr.doc.content.size - after;
      if (end >= section.from && tr.doc.content.cut(0, section.from).eq(state.doc.content.cut(0, section.from)) &&
          tr.doc.content.cut(end).eq(state.doc.content.cut(section.to))) return true;
      message?.("Open the full document to edit beyond this section.");
      return false;
    },
    appendTransaction(_transactions, _previous, state) {
      const section = sectionKey.getState(state);
      if (!section) return null;
      const { anchor, head } = state.selection;
      const clamp = (pos: number) => Math.min(section.to - 1, Math.max(section.from + 1, pos));
      if (clamp(anchor) === anchor && clamp(head) === head) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, clamp(anchor), clamp(head)));
    },
    props: {
      decorations(state) {
        const section = sectionKey.getState(state);
        if (!section) return null;
        const hidden: Decoration[] = [];
        state.doc.forEach((block, pos) => {
          if (pos < section.from || pos >= section.to) {
            hidden.push(Decoration.node(pos, pos + block.nodeSize, { style: "display: none", "aria-hidden": "true", contenteditable: "false" }));
          }
        });
        return DecorationSet.create(state.doc, hidden);
      },
      handleKeyDown(view, event) {
        const { state } = view;
        const section = sectionKey.getState(state);
        if (!section) return false;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          const selection = TextSelection.create(state.doc, section.from + 1, section.to - 1);
          view.dispatch(state.tr.setSelection(selection));
          return true;
        }
        if (!state.selection.empty) return false;
        const pos = state.selection.head;
        return (event.key === "Backspace" && pos === section.from + 1) || (event.key === "Delete" && pos === section.to - 1);
      },
    },
  });
}
