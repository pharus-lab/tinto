// Keep the original highlight key so existing manuscripts and versions open with underlines.
export const markTags = { strong: "strong", em: "em", highlight: "u" } as const;
// Where text came from, when the writer did not type it in Tinto. Unmarked text
// was written here. The mark stays inside Tinto: exports and posts leave it out.
export type OriginSource = "pasted" | "imported" | "ai";
export type FormatMark = { type: keyof typeof markTags };
export type OriginMark = { type: "origin"; attrs: { source: OriginSource } };
export type MarkJSON = FormatMark | OriginMark;
export type TextJSON = { type: "text"; text: string; marks?: MarkJSON[] };
export type OptionJSON = { id: string; content?: InlineJSON[] };
export type ChoiceJSON = { type: "choice"; marks?: MarkJSON[]; attrs: { id: string; active: string; options: OptionJSON[] }; content?: InlineJSON[] };
export type InlineJSON = TextJSON | ChoiceJSON;
export type MarkdownBlock = { content: InlineJSON[]; separator?: string };
export type BlockJSON = { type: "paragraph" | "heading"; attrs: { id: string; level?: number }; content?: InlineJSON[]; markdown?: MarkdownBlock };
export type Manuscript = { type: "doc"; content: BlockJSON[] };

// Intervals between keystrokes are counted in these bands, in milliseconds;
// the last band holds every longer interval.
export const INTERVAL_BANDS = [50, 100, 200, 400, 800, 1600, 5000];

export const formatMarks = (marks: MarkJSON[] = []) => marks.filter((mark): mark is FormatMark => mark.type !== "origin");
export const originOf = (marks: MarkJSON[] = []): OriginSource | null => marks.find((mark): mark is OriginMark => mark.type === "origin")?.attrs.source ?? null;

// Compare what the writer can see and choose. Adjacent text with the same
// formatting is one run, even when the editor tracks different origins.
export function comparableInlines(nodes: InlineJSON[] = []): InlineJSON[] {
  const runs: InlineJSON[] = [];
  for (const node of nodes) {
    const marks = [...new Set(formatMarks(node.marks).map(mark => mark.type))].sort().map(type => ({ type }));
    if (node.type === "choice") {
      const { id, active } = node.attrs;
      const options = node.attrs.options.map(option => ({ id: option.id, content: comparableInlines(option.content) }));
      runs.push({ type: node.type, attrs: { id, active, options }, marks, content: comparableInlines(node.content) });
    } else {
      const previous = runs.at(-1);
      if (previous?.type === "text" && previous.marks?.length === marks.length && previous.marks.every((mark, i) => mark.type === marks[i].type)) previous.text += node.text;
      else runs.push({ type: "text", text: node.text, marks });
    }
  }
  return runs;
}

// Marks every character of imported or generated text with its origin, inactive options included.
export function withOrigin<T extends InlineJSON>(nodes: T[], source: OriginSource): T[] {
  return nodes.map(node => {
    if (node.type === "text") return { ...node, marks: [...formatMarks(node.marks), { type: "origin", attrs: { source } }] };
    const options = node.attrs.options.map(option => option.content ? { ...option, content: withOrigin(option.content, source) } : option);
    return { ...node, attrs: { ...node.attrs, options }, ...(node.content ? { content: withOrigin(node.content, source) } : {}) };
  }) as T[];
}
export function manuscriptWithOrigin(doc: Manuscript, source: OriginSource): Manuscript {
  return { ...doc, content: doc.content.map(block => ({
    ...block, ...(block.content && { content: withOrigin(block.content, source) }),
    ...(block.markdown && { markdown: { ...block.markdown, content: withOrigin(block.markdown.content, source) } })
  })) };
}

export function visibleText(node: Manuscript | BlockJSON | InlineJSON): string {
  if (node.type === "text") return node.text;
  return node.content?.map(visibleText).join(node.type === "doc" ? "\n" : "") ?? "";
}

export function newBlock(text = "", level?: number): BlockJSON {
  const id = crypto.randomUUID();
  const block: BlockJSON = level ? { type: "heading", attrs: { id, level } } : { type: "paragraph", attrs: { id } };
  if (text) block.content = [{ type: "text", text }];
  return block;
}

// Block indexes are half-open. A removed heading yields an empty section.
export function sectionRange(doc: Manuscript, headingId: string): { from: number; to: number } {
  const from = doc.content.findIndex(block => block.type === "heading" && block.attrs.id === headingId);
  if (from < 0) return { from: 0, to: 0 };
  const level = doc.content[from].attrs.level ?? 1;
  let to = from + 1;
  while (to < doc.content.length) {
    const block = doc.content[to];
    if (block.type === "heading" && (block.attrs.level ?? 1) <= level) break;
    to++;
  }
  return { from, to };
}

// An active option uses its choice node's editable content. Inactive options
// each own their entire inline tree, including nested choices and marks.
export function copyInlines(nodes: InlineJSON[]): InlineJSON[] {
  return nodes.map(node => {
    if (node.type === "text") return structuredClone(node);
    const options = node.attrs.options.map(option => ({ id: crypto.randomUUID(), ...(option.content ? { content: copyInlines(option.content) } : {}) }));
    const index = node.attrs.options.findIndex(option => option.id === node.attrs.active);
    return { type: "choice", attrs: { id: crypto.randomUUID(), active: options[index].id, options }, content: copyInlines(node.content ?? []) };
  });
}

export const SAMPLE_SENTENCE = "kitchen-sentence";
export const SAMPLE_FOOD = "kitchen-food";

export function sampleManuscript(): Manuscript {
  const text = (value: string): TextJSON => ({ type: "text", text: value });
  const food: ChoiceJSON = {
    type: "choice",
    attrs: { id: SAMPLE_FOOD, active: "food-b", options: [{ id: "food-a", content: [text("ice cream")] }, { id: "food-b" }] },
    content: [text("cake")],
  };
  const sentence: ChoiceJSON = {
    type: "choice",
    attrs: { id: SAMPLE_SENTENCE, active: "sentence-b", options: [{ id: "sentence-a", content: [text("I want to eat a cat.")] }, { id: "sentence-b" }] },
    content: [text("I want to eat "), food, text(".")],
  };
  const kitchen = newBlock("The kitchen", 1);
  kitchen.attrs.id = "the-kitchen";
  const conversation = newBlock();
  conversation.content = [text("Her brother looked up from the table. “"), sentence, text("”")];
  const garden = newBlock("The garden", 1);
  garden.attrs.id = "the-garden";
  return { type: "doc", content: [
    kitchen,
    newBlock("The house was quiet when Mara arrived. Someone had left the kitchen light on, and the window above the sink stood open to the rain."),
    conversation,
    newBlock("“You always say that,” she said, setting her bag beside the door. For the first time all day, he smiled."),
    newBlock("There were two cups on the table. The one nearest the window still had a little tea in it. She drew it towards her and warmed her hands around the china."),
    newBlock("Outside, the rain tapped against the leaves of the old pear tree. She had forgotten how close it grew to the house."),
    garden,
    newBlock("By morning the garden path was clear. Mara went out in her slippers, carrying the empty cups."),
    newBlock("Under the pear tree, someone had planted a row of white crocuses. Their petals were still closed against the cold."),
    newBlock("She stood there until her brother opened the kitchen window and called her in."),
  ] };
}
