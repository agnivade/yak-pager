/**
 * Seed document — long enough to span 4+ pages, with headings, a horizontal
 * rule, mixed marks (strong / em / fontSize) and one explicit pageBreak node
 * so the forced-break path is visible on first load.
 */
import { schema } from "./schema"
import type { Node, Mark } from "prosemirror-model"

const m = {
  strong: () => schema.marks.strong.create(),
  em: () => schema.marks.em.create(),
  size: (px: number) => schema.marks.fontSize.create({ size: px }),
}

function text(str: string, marks: Mark[] = []) {
  return schema.text(str, marks)
}

function heading(level: 1 | 2 | 3, str: string) {
  return schema.nodes.heading.create({ level }, schema.text(str))
}

function para(...inlines: (string | Node)[]) {
  const content = inlines.map((i) => (typeof i === "string" ? text(i) : i))
  return schema.nodes.paragraph.create(null, content)
}

const SECTIONS: Array<{ title: string; paras: string[][] }> = [
  {
    title: "1. The document is a flat list of blocks",
    paras: [
      ["The first architectural rule of this demo is that pagination never enters the document."],
      ["There is no page node in the schema, no section wrapper, no column structure. The document is a flat sequence of paragraphs, headings, rules, and explicit break markers, and it stays that way no matter how many pages the content occupies."],
      ["Computed break positions live in plugin state only. They are never serialized with the document, never appear in an undo event, and never travel through a transaction that changes the document. If you press Ctrl+Z right now, you will undo typing — never the pagination that resulted from typing."],
      ["That property is what would let the same document model back onto a collaborative CRDT later without any changes: peers replicate authorial intent, and layout is recomputed locally from measurements."],
      ["A page, in this demo, is not a thing. It is a region of a single continuous flow. Sheet backgrounds are painted behind the flow, and each break inserts a gap widget whose box height is the entire inter-page space — the band between sheets plus the ragged bottom of the page above. Content therefore never moves between pages, and no block's DOM is ever touched by a reflow."],
      ["Because content never moves between pages, a reflow is just a re-derivation of numbers. When a break moves, the only DOM operations are an insertBefore on the reused gap widget and a couple of attribute writes — the dev panel logs every one of them, captured by a MutationObserver bracketing the reflow."],
    ],
  },
  {
    title: "2. Measure, then solve, then decorate",
    paras: [
      ["The plugin separates cleanly into three pieces. Measure walks the top-level blocks and reads their rendered heights. Solve is a pure function from numbers to break positions. Decorate turns those positions into ProseMirror decorations."],
      ["Measurement is cached in a WeakMap keyed by node identity. ProseMirror nodes are immutable values: editing a paragraph produces a new node object, while untouched blocks keep theirs across the transaction. Unchanged blocks are therefore cache hits by object identity, with no bookkeeping at all."],
      ["On top of that, the plugin tracks the transaction's changed range through the step maps and remaps it through later steps, so invalidation is explicit and deterministic rather than purely implicit."],
      ["Solving never touches the DOM. Heights accumulate; when a block would overflow a non-empty page, a break is recorded before it and the accumulator resets. An explicit page-break node forces a reset wherever it appears."],
      ["Decorating happens in a single meta-transaction that carries no steps, which is why it is invisible to history. One widget per break, one node decoration per pushed block."],
    ],
  },
  {
    title: "3. Decorations are not nodes",
    paras: [
      ["A decoration is view-layer annotation attached to a position range. It never changes the document, never serializes, and never lands in the undo stack. That is precisely why pagination is expressed as decorations rather than as nodes: it is derived, local, and disposable."],
      ["The gap between pages is a widget decoration: a contenteditable=false div with a stable key, pooled and reused, that ProseMirror re-inserts at a new position with an insertBefore when a break moves. No element is created or destroyed when a break moves."],
      ["The push onto the next page also lives inside that widget — its box height derives from a --push CSS variable set to the ragged space left above. The obvious alternative, a node decoration with a margin-top style, was tried and rejected: prosemirror-view reconciles attribute mutations on block descs by marking them dirty and rebuilding their elements, which quietly violated the no-churn rule. Widgets are exempt — ignoreMutation ignores everything inside them — so all layout writes go through the widget."],
      ["Marks, by contrast — like the bold, italic, and larger text sprinkled through this seed document — are part of the document. Applying one is a real transaction with steps. That is the dividing line: authorial intent goes in the doc, derived layout stays out."],
    ],
  },
  {
    title: "4. Scheduling and stability",
    paras: [
      ["Measurement never happens synchronously inside a transaction. A transaction only marks a dirty range in plugin state; the plugin's view schedules a requestAnimationFrame pass, debounced about a hundred milliseconds, so bursts of typing collapse into one reflow."],
      ["The pass batches all DOM reads first, then solves on pure numbers, then writes. Reads and writes never interleave, so the browser lays out once per pass instead of thrashing."],
      ["The pass is idempotent. Decorations are rebuilt from the same measurements into the same values, and every write is change-checked, so re-running the pass on a stable layout performs zero DOM operations. The dev panel has a button that does exactly this, so you can verify it empirically rather than on trust."],
      ["Fonts settling or the window resizing can change rendered heights without the document changing at all, so those events trigger a full re-measure through a meta-transaction — no steps, no history entry, no document change."],
      ["Overflowing blocks — a single paragraph taller than a page — are pushed whole onto their own page and visibly spill past the sheet edge. Splitting them mid-paragraph is deliberately out of scope; ragged and imperfect output is fine, because the goal is correct, fast, stable pagination, not export parity."],
      ["Undo composes cleanly with all of this: Ctrl+Z replays the inverse of your typing steps, the decorations map themselves through the changed positions, and the next debounced pass re-derives the layout from fresh measurements. At no point does an undo ever walk through a pagination state."],
    ],
  },
  {
    title: "5. What to poke at",
    paras: [
      ["Type at the end of a nearly full page and watch the log in the panel: a break moves with one insertBefore and one attribute write, and nothing else happens."],
      ["Hold Backspace to delete a heading and watch a break disappear — the widget is removed only because the page count shrank, which is the one structural change reflow is allowed to make."],
      ["Select this sentence and bump the font size in the toolbar. Marks are document transactions, so the heights change, the dirty range widens, and pagination re-solves — with undo still working on the mark itself."],
      ["Press the re-run button in the panel to force a full re-measure of the stable layout. The log should come back empty: same measurements, same solve, same decorations, zero DOM writes. That is the idempotence guarantee, made observable."],
      ["Press Ctrl+Z a few times after editing. The document returns to exactly this seed — page nodes found in the JSON: zero, then, now, and always."],
    ],
  },
]

export function buildSeedDoc(): Node {
  const children: Node[] = []

  children.push(
    heading(1, "yak-pager — a paged ProseMirror, honestly"),
    para(
      text("This document is "),
      text("one flat list of blocks", [m.strong()]),
      text(" rendered to look like pages. There are no page nodes in it — check with the "),
      text("Dump doc.toJSON()", [m.em()]),
      text(" button in the panel. Page breaks are computed from measured heights and drawn as decorations.")
    ),
    para(
      text("Try it: type at the end of a full page and watch a break move in the log; press ", []),
      text("Ctrl/⌘-Z", [m.strong()]),
      text(" and watch only the typing undo. Insert explicit breaks with the toolbar or ", []),
      text("Mod-Enter", [m.strong()]),
      text(".")
    ),
    para(
      text("Font size is a mark too — ", []),
      text("like this 20px span", [m.size(20)]),
      text(" — and since marks change rendered heights, resizing text reflows pages through the same measure-solve-decorate pipeline.")
    ),
    schema.nodes.horizontal_rule.create()
  )

  for (const section of SECTIONS) {
    children.push(heading(2, section.title))
    for (const sentences of section.paras) {
      children.push(para(sentences.join(" ")))
    }
  }

  // An explicit, authorial page break: this one IS a document node.
  children.push(
    schema.nodes.pageBreak.create(),
    heading(2, "6. After an explicit page break"),
    para(
      "Everything after the marker above begins on a fresh page because the author said so. The solver treats the marker as a forced break: the page ends after it renders, regardless of how much room was left."
    ),
    para(
      "Delete the marker (select it with two clicks or Backspace from the line below) and this section reflows back up — computed pagination fills the gap, and the explicit break disappears from the document."
    ),
    heading(3, "A level-three heading, for block-type variety"),
    para(
      "Heading levels matter to pagination only through their measured heights — the solver never inspects node types, except to notice forced-break nodes. Everything else is just a number of pixels."
    ),
    para(
      "That is the whole point of the separation: the solver reasons about positions and heights, the plugin owns scheduling and invalidation, and the decorations own presentation. Swap any piece out without touching the others."
    )
  )

  return schema.nodes.doc.create(null, children)
}
