/**
 * Schema — a flat list of blocks. There are NO page nodes here; that is rule 1.
 * Computed breaks live in plugin state only. The one exception is `pageBreak`,
 * which *is* authorial intent ("start a new page here"), so it belongs in the
 * document like any other content — it round-trips through serialization and
 * undo like a paragraph would.
 *
 * Built on prosemirror-schema-basic: doc/paragraph/text/hard_break/
 * horizontal_rule specs are reused verbatim; heading is constrained to
 * levels 1-3; blockquote/image are dropped; the fontSize mark is added.
 */
import { Schema } from "prosemirror-model"
import type { Node, Mark, DOMOutputSpec } from "prosemirror-model"
import { nodes as basicNodes, marks as basicMarks } from "prosemirror-schema-basic"

const { doc, paragraph, text, hard_break, horizontal_rule } = basicNodes
const { strong, em } = basicMarks

const heading = {
  attrs: { level: { default: 1 } },
  content: "inline*",
  group: "block",
  defining: true,
  parseDOM: [
    { tag: "h1", attrs: { level: 1 } },
    { tag: "h2", attrs: { level: 2 } },
    { tag: "h3", attrs: { level: 3 } },
  ],
  toDOM(node: Node): DOMOutputSpec {
    return ["h" + node.attrs.level, 0]
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
