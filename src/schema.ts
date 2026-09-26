/**
 * Schema — a flat list of blocks. There are NO page nodes here; that is rule 1.
 * Computed breaks live in plugin state only. The one exception is `pageBreak`,
 * which *is* authorial intent ("start a new page here"), so it belongs in the
 * document like any other content — it round-trips through serialization and
 * undo like a paragraph would.
 *
 * Built on prosemirror-schema-basic: doc/text/hard_break/horizontal_rule
 * specs are reused verbatim; paragraph is our own spec carrying an `align`
 * attr; heading is constrained to levels 1-3 and carries the same attr;
 * blockquote/image are dropped; the fontSize mark is added.
 *
 * Alignment (left/center/right/justify) is authorial intent, so it lives on
 * the block as a node attr — one real transaction, undoable, serialized.
 * "left" is the default and renders with no style attribute, so ordinary
 * paragraphs keep a clean `<p>` in the DOM.
 */
import { Schema } from "prosemirror-model"
import type { Node, Mark, DOMOutputSpec } from "prosemirror-model"
import { nodes as basicNodes, marks as basicMarks } from "prosemirror-schema-basic"

const { doc, text, hard_break, horizontal_rule } = basicNodes
const { strong, em } = basicMarks

const ALIGN_VALUES = ["left", "center", "right", "justify"]

/** Parse `text-align` off a parsed element; anything unknown is "left". */
function alignFromDOM(dom: string | HTMLElement): string {
  const v = (dom as HTMLElement).style?.textAlign
  return ALIGN_VALUES.includes(v) ? v : "left"
}

/** DOM attributes for a block's alignment: a style only when not default. */
function alignAttrs(node: Node): { style?: string } {
  const a = node.attrs.align
  return a && a !== "left" ? { style: `text-align: ${a}` } : {}
}

const alignAttr = { align: { default: "left" } }

const paragraph = {
  attrs: alignAttr,
  content: "inline*",
  group: "block",
  parseDOM: [
    {
      tag: "p",
      getAttrs(dom: string | HTMLElement) {
        return { align: alignFromDOM(dom) }
      },
    },
  ],
  toDOM(node: Node): DOMOutputSpec {
    return ["p", alignAttrs(node), 0]
  },
}

const heading = {
  attrs: { level: { default: 1 }, ...alignAttr },
  content: "inline*",
  group: "block",
  defining: true,
  parseDOM: ([1, 2, 3] as const).map((level) => ({
    tag: "h" + level,
    getAttrs(dom: string | HTMLElement) {
      return { level, align: alignFromDOM(dom) }
    },
  })),
  toDOM(node: Node): DOMOutputSpec {
    return ["h" + node.attrs.level, alignAttrs(node), 0]
  },
}

/**
 * Explicit, user-inserted page break. Atomic: no content, indivisible.
 * Rendered as a visible marker strip so the author can see and delete it.
 */
const pageBreak = {
  group: "block",
  atom: true,
  selectable: true,
  parseDOM: [{ tag: "div[data-page-break]" }],
  toDOM(): DOMOutputSpec {
    return ["div", { "data-page-break": "true" }]
  },
}

/** fontSize mark: `size` attribute in px, rendered as an inline style. */
const fontSize = {
  attrs: { size: { default: 16 } },
  parseDOM: [
    {
      tag: "span[style]",
      getAttrs(dom: string | HTMLElement) {
        const el = dom as HTMLElement
        const m = el.style.fontSize.match(/^(\d+(?:\.\d+)?)px$/)
        return m ? { size: Math.round(parseFloat(m[1])) } : false
      },
    },
  ],
  toDOM(mark: Mark): DOMOutputSpec {
    return ["span", { style: `font-size: ${mark.attrs.size}px` }]
  },
}

export const schema = new Schema({
  nodes: { doc, paragraph, heading, text, hard_break, horizontal_rule, pageBreak },
  marks: { strong, em, fontSize },
})
