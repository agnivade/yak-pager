/**
 * Alignment (left/center/right/justify) at the schema and command level.
 * These run in a node environment, so there is no DOM here: they check the
 * attr, its serialization, and the command's transactions. The DOM side
 * (inline style in, text-align out, flush justified lines) is covered by
 * tests/e2e.mjs.
 */
import { describe, it, expect } from "vitest"
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state"
import type { Command } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { buildSeedDoc } from "../src/seed"
import { setAlign } from "../src/toolbar"

/** Run a command against a state and return the state it produced (or null). */
function run(cmd: Command, state: EditorState): EditorState | null {
  let next: EditorState | null = null
  cmd(state, (tr) => {
    next = state.apply(tr)
  })
  return next
}

describe("align attr", () => {
  it("exists on paragraph and heading, defaulting to left", () => {
    const p = schema.nodes.paragraph.createAndFill()
    expect(p?.attrs.align).toBe("left")
    const h = schema.nodes.heading.createAndFill({ level: 2 })
    expect(h?.attrs.align).toBe("left")
  })

  it("the seed carries one justified paragraph", () => {
    const doc = buildSeedDoc()
    const aligned: string[] = []
    doc.descendants((node: PMNode) => {
      if ("align" in node.attrs && node.attrs.align !== "left") aligned.push(node.attrs.align)
    })
    expect(aligned).toEqual(["justify"])
  })

  it("survives serialization (toJSON/fromJSON)", () => {
    const doc = schema.nodeFromJSON(buildSeedDoc().toJSON())
    const justified = [] as PMNode[]
    doc.descendants((node: PMNode) => {
      if (node.type.name === "paragraph" && node.attrs.align === "justify") justified.push(node)
    })
    expect(justified).toHaveLength(1)
  })
})

describe("setAlign", () => {
  const doc = buildSeedDoc()

  // First heading and the paragraph right after it, for a mixed selection.
  const positions: Record<string, number> = {}
  doc.descendants((node: PMNode, pos: number) => {
    if (positions.heading == null && node.type.name === "heading") positions.heading = pos
    if (positions.heading != null && positions.paragraph == null && node.type.name === "paragraph") positions.paragraph = pos
    if (positions.rule == null && node.type.name === "horizontal_rule") positions.rule = pos
  })

  it("over a heading + paragraph selection it changes both, converting nothing", () => {
    const from = positions.heading + 1
    const to = positions.paragraph + 3
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) })
    const next = run(setAlign("center"), state)
    expect(next).not.toBeNull()

    const seen: Array<{ name: string; level?: number; align: string }> = []
    next!.doc.nodesBetween(from, to, (node: PMNode) => {
      if (node.isTextblock) seen.push({ name: node.type.name, level: node.attrs.level, align: node.attrs.align })
    })
    // The heading must still be a heading (a blanket setBlockType would have
    // flattened it into a paragraph) with its level intact.
    expect(seen[0]).toEqual({ name: "heading", level: 1, align: "center" })
    expect(seen.some((b) => b.name === "paragraph" && b.align === "center")).toBe(true)
  })

  it("with a caret it changes only the block holding the caret", () => {
    const caret = positions.paragraph + 2
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })
    const next = run(setAlign("right"), state)
    expect(next!.doc.resolve(caret).parent.attrs.align).toBe("right")
    expect(next!.doc.resolve(caret).parent.attrs.align).not.toBe(state.doc.resolve(caret).parent.attrs.align)
    // The block before the caret is untouched.
    expect(state.doc.resolve(positions.heading + 1).parent.attrs.align).toBe("left")
  })

  it("is a no-op (returns false) when nothing would change", () => {
    const justified = buildSeedDoc()
    let pos = 0
    justified.descendants((node: PMNode, p: number) => {
      if (node.attrs.align === "justify") pos = p
    })
    const state = EditorState.create({ doc: justified, selection: TextSelection.create(justified, pos + 2) })
    expect(setAlign("justify")(state, () => {})).toBe(false)
  })

  it("does nothing inside a block without the attr (a rule)", () => {
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, positions.rule) })
    expect(setAlign("center")(state, () => {})).toBe(false)
  })
})
