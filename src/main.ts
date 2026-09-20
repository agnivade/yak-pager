import { EditorState } from "prosemirror-state"
import type { Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { keymap } from "prosemirror-keymap"
import { baseKeymap } from "prosemirror-commands"
import { history, undo, redo } from "prosemirror-history"
import { buildSeedDoc } from "./seed"
import { paginationPlugin, paginationKey, requestFullRecompute } from "./paginationPlugin"
import { buildToolbar, insertPageBreak, insertHardBreak } from "./toolbar"
import { createDevPanel } from "./devPanel"
import "./styles.css"

const paperHost = document.getElementById("paper")!
const panel = createDevPanel(document.getElementById("panel")!)

let toolbar: { sync: () => void } | null = null

const view = new EditorView(paperHost, {
  state: EditorState.create({
    doc: buildSeedDoc(),
    plugins: [
      history(),
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        "Mod-Enter": insertPageBreak,
        "Shift-Enter": insertHardBreak,
      }),
      keymap(baseKeymap),
      paginationPlugin({ onReflow: (r) => panel.report(r) }),
    ],
  }),
  dispatchTransaction(tr: Transaction) {
    view.updateState(view.state.apply(tr))
    toolbar?.sync()
    panel.sync()
  },
})

toolbar = buildToolbar(view, document.getElementById("toolbar")!)
panel.attach(view)

  // Poke at the editor from the console: window.__pager.view.state.doc, ...
  // (also used by tests/e2e.mjs to verify widget placement against the doc —
  // the key is how it reads the pagination state out of the built bundle).
  ; (window as unknown as { __pager: { view: EditorView; key: typeof paginationKey } }).__pager = {
    view,
    key: paginationKey,
  }

// Heights can change without the document changing: fonts settling, images
// loading, the window resizing. Each triggers a full re-measure through a
// meta-transaction; the pass itself stays debounced and idempotent.
if (typeof document !== "undefined" && "fonts" in document) {
  document.fonts.ready.then(() => requestFullRecompute(view))
}
window.addEventListener("resize", () => requestFullRecompute(view))
// Capture phase: <load> does not bubble, and it fires on descendants.
paperHost.addEventListener(
  "load",
  (e) => {
    if ((e.target as HTMLElement)?.tagName === "IMG") requestFullRecompute(view)
  },
  true
)
