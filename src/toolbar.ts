/**
 * Toolbar — bold, italic, font size, block type, and the button that inserts
 * an *explicit* page break (the one kind of break that IS a document node).
 *
 * The interesting bit conceptually: marks are ranges in the document, so
 * applying one is a normal transaction (undoable, serializable). Contrast
 * with computed pagination, which never produces a transaction with steps.
 */
import type { EditorView } from "prosemirror-view"
import { toggleMark, setBlockType } from "prosemirror-commands"
import type { Command } from "prosemirror-state"
import { schema } from "./schema"

const { strong, em, fontSize } = schema.marks

function setFontSize(size: number | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const tr = state.tr
    if (empty) {
      // Empty selection: set a *stored* mark so the next typed text gets it.
      tr.removeStoredMark(fontSize)
      if (size != null) tr.addStoredMark(fontSize.create({ size }))
    } else {
      tr.removeMark(from, to, fontSize)
      if (size != null) tr.addMark(from, to, fontSize.create({ size }))
    }
    dispatch?.(tr)
    return true
  }
}

export function insertPageBreak(state: Parameters<Command>[0], dispatch?: Parameters<Command>[1]) {
  if (!schema.nodes.pageBreak) return false
  if (dispatch) {
    dispatch(
      state.tr
        .replaceSelectionWith(schema.nodes.pageBreak.create())
        .scrollIntoView()
    )
  }
  return true
}

/**
 * Shift-Enter: insert a hard_break — the schema's one inline node. A line
 * end *inside* a block, not a new block. Refused when the cursor is not in
 * inline content (e.g. a block node is selected), where it would not fit.
 */
export function insertHardBreak(state: Parameters<Command>[0], dispatch?: Parameters<Command>[1]) {
  if (!schema.nodes.hard_break) return false
  if (!state.selection.$from.parent.inlineContent) return false
  if (dispatch) {
    dispatch(
      state.tr
        .replaceSelectionWith(schema.nodes.hard_break.create())
        .scrollIntoView()
    )
  }
  return true
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32]

export function buildToolbar(view: EditorView, mount: HTMLElement): { sync: () => void } {
  const run = (cmd: Command) => () => {
    cmd(view.state, view.dispatch, view)
    view.focus()
  }

  const strongBtn = document.createElement("button")
  strongBtn.innerHTML = "<strong>B</strong>"
  strongBtn.title = "Bold (Mod-B)"
  strongBtn.onclick = run(toggleMark(strong))

  const emBtn = document.createElement("button")
  emBtn.innerHTML = "<em>I</em>"
  emBtn.title = "Italic (Mod-I)"
  emBtn.onclick = run(toggleMark(em))

  const sizeSel = document.createElement("select")
  sizeSel.title = "Font size"
  const clearOpt = document.createElement("option")
  clearOpt.value = ""
  clearOpt.textContent = "size –"
  sizeSel.append(clearOpt)
  for (const s of FONT_SIZES) {
    const o = document.createElement("option")
    o.value = String(s)
    o.textContent = `${s}px`
    sizeSel.append(o)
  }
  sizeSel.onchange = () => {
    const v = sizeSel.value
    run(setFontSize(v === "" ? null : Number(v)))()
  }

  const blockSel = document.createElement("select")
  blockSel.title = "Block type"
  const blockOptions: Array<[string, Command]> = [
    ["Paragraph", setBlockType(schema.nodes.paragraph)],
    ["Heading 1", setBlockType(schema.nodes.heading, { level: 1 })],
    ["Heading 2", setBlockType(schema.nodes.heading, { level: 2 })],
    ["Heading 3", setBlockType(schema.nodes.heading, { level: 3 })],
  ]
  for (const [label] of blockOptions) {
    const o = document.createElement("option")
    o.value = label
    o.textContent = label
    blockSel.append(o)
  }
  blockSel.onchange = () => {
    const cmd = blockOptions.find(([label]) => label === blockSel.value)?.[1]
    if (cmd) run(cmd)()
  }

  const pbBtn = document.createElement("button")
  pbBtn.textContent = "⤓ Page break"
  pbBtn.title = "Insert explicit page break (Mod-Enter)"
  pbBtn.onclick = run(insertPageBreak)

  const hint = document.createElement("span")
  hint.className = "tb-hint"
  hint.textContent = "Ctrl/⌘-Z undoes typing — pagination is never in the undo stack"

  mount.append(strongBtn, emBtn, sizeSel, blockSel, pbBtn, hint)

  const sync = () => {
    const { state } = view
    const { selection, storedMarks } = state
    const marksAt = storedMarks ?? selection.$from.marks()
    const range = !selection.empty
    strongBtn.classList.toggle("active", range ? state.doc.rangeHasMark(selection.from, selection.to, strong) : strong.isInSet(marksAt) != null)
    emBtn.classList.toggle("active", range ? state.doc.rangeHasMark(selection.from, selection.to, em) : em.isInSet(marksAt) != null)
    const fs = fontSize.isInSet(marksAt)
    sizeSel.value = fs ? String(fs.attrs.size) : ""
    const parent = selection.$from.parent
    blockSel.value =
      parent.type.name === "heading" ? `Heading ${parent.attrs.level}` : "Paragraph"
  }
  sync()
  return { sync }
}
