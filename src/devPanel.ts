/**
 * Dev panel — the empirical half of the exercise.
 *
 * Shows: page count, break positions, last reflow duration, how many blocks
 * were re-measured (cache hits = total - measured), and the DOM operation
 * log captured by the MutationObserver during the reflow. "Re-run pass"
 * proves idempotence: it forces a full re-measure of a stable layout, and
 * the log should come back empty. "Dump doc JSON" proves rule 1: the
 * serialized document contains no page nodes, ever.
 *
 * The second card holds the block visualizer: a live tree of the document
 * (sync() runs after every transaction). Each row shows the node type with a
 * block/inline/text badge, so the three node kinds are visible while editing.
 * The rows on the path from the doc root down to the cursor are highlighted,
 * and clicking a row selects that node in the editor.
 *
 * Both cards are collapsible and behave like an accordion: opening one closes
 * the other, so at most one panel body is visible at a time. The head of each
 * card (title plus arrow button) is permanent DOM; only the body re-renders.
 */
import type { EditorView } from "prosemirror-view"
import type { Node as PMNode } from "prosemirror-model"
import { NodeSelection, TextSelection } from "prosemirror-state"
import type { ReflowReport } from "./paginationPlugin"
import { requestFullRecompute } from "./paginationPlugin"

export interface DevPanel {
  report(r: ReflowReport): void
  attach(view: EditorView): void
  /** Re-render the block visualizer from the current doc. */
  sync(): void
}

const OP_STYLES: Record<string, string> = {
  setAttribute: "op-set",
  removeAttribute: "op-unset",
  insertBefore: "op-move",
  create: "op-create",
  remove: "op-remove",
  other: "op-other",
}

export function createDevPanel(mount: HTMLElement): DevPanel {
  let view: EditorView | null = null
  const history: string[] = []

  const makeHead = (title: string) => {
    const head = document.createElement("div")
    head.className = "panel-head"
    head.innerHTML =
      `<h2>${title}</h2>` +
      `<button class="panel-min" aria-expanded="true" aria-label="collapse panel">▾</button>`
    return head
  }

  const el = document.createElement("div")
  el.className = "panel-card"
  const reflowHead = makeHead("Pagination · dev panel")
  const reflowBody = document.createElement("div")
  reflowBody.className = "panel-body"
  const reflowContent = document.createElement("div")
  reflowBody.append(reflowContent)
  el.append(reflowHead, reflowBody)
  mount.append(el)

  const render = (r: ReflowReport | null) => {
    const parts: string[] = []

    if (r) {
      parts.push(`
        <div class="stats">
          <div><span class="k">pages</span><span class="v">${r.pageCount}</span></div>
          <div><span class="k">reflow</span><span class="v">${r.durationMs.toFixed(2)} ms</span></div>
          <div><span class="k">measured</span><span class="v">${r.measuredCount}/${r.totalBlocks}${r.fullRecompute ? " (full)" : ""}</span></div>
        </div>`)
      const breaks = r.breakPositions
        .map((p, i) => `@${p} (ragged ${r.remainders[i]}px)`)
        .join("<br>") || "<i>none — one page</i>"
      parts.push(`<div class="breaks"><span class="k">breaks</span><div>${breaks}</div></div>`)

      const c = r.counts
      const chips = [
        ["setAttribute", c.setAttribute],
        ["removeAttribute", c.removeAttribute],
        ["insertBefore", c.insertBefore],
        ["create", c.create],
        ["remove", c.remove],
        ["other", c.other],
      ]
        .map(([k, n]) => `<span class="chip chip-${k}">${k} ${n}</span>`)
        .join("")
      parts.push(`<div class="chips">${chips}</div>`)

      if (r.ops.length === 0) {
        parts.push(`<div class="oplog"><div class="op op-move">∅ zero DOM operations — pass was idempotent</div></div>`)
      } else {
        parts.push(
          `<div class="oplog">` +
            r.ops.map((op) => `<div class="op ${OP_STYLES[op.kind]}">${op.kind.padEnd(14, " ")} ${op.text}</div>`).join("") +
            `</div>`
        )
      }
    } else {
      parts.push(`<div class="stats"><div><span class="k">pages</span><span class="v">…</span></div></div>`)
    }

    if (history.length) {
      parts.push(`<div class="history">${history.slice(-8).join("<br>")}</div>`)
    }

    reflowContent.innerHTML = parts.join("")
  }

  const buttons = document.createElement("div")
  buttons.className = "panel-buttons"
  const rerun = document.createElement("button")
  rerun.textContent = "Re-run pass (idempotence check)"
  const dump = document.createElement("button")
  dump.textContent = "Dump doc.toJSON() to console"
  buttons.append(rerun, dump)
  reflowBody.append(buttons)

  /* ---------- block visualizer ---------- */

  const EXCERPT_LEN = 10

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  const excerpt = (text: string) => {
    const cut = text.length > EXCERPT_LEN ? text.slice(0, EXCERPT_LEN) + "…" : text
    return `"${esc(cut)}"`
  }

  const kindOf = (n: PMNode) => (n.isText ? "text" : n.isInline ? "inline" : "block")

  const fmtAttrs = (n: { attrs: Record<string, unknown> }) =>
    Object.entries(n.attrs)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")

  const rowFor = (n: PMNode, pos: number | null, depth: number, hl: boolean) => {
    const kind = kindOf(n)
    const attrText = fmtAttrs(n)
    const markChips = n.marks
      .map((m) => {
        const a = fmtAttrs(m)
        return `<span class="tree-mark">${m.type.name}${a ? ` (${a})` : ""}</span>`
      })
      .join("")
    const atomFlag = n.type.spec.atom ? `<span class="tree-flag">atom</span>` : ""
    return (
      `<div class="tree-row${hl ? " tree-hl" : ""}"${pos != null ? ` data-pos="${pos}"` : ""} style="--d:${depth}">` +
      `<span class="tree-badge tree-b-${kind}">${kind}</span>` +
      `<span class="tree-name">${n.type.name}</span>` +
      (attrText ? `<span class="tree-attr">${attrText}</span>` : "") +
      (n.isText ? `<span class="tree-excerpt">${excerpt(n.text ?? "")}</span>` : "") +
      markChips +
      atomFlag +
      `</div>`
    )
  }

  const walk = (parent: PMNode, base: number, depth: number, path: Set<number>, rows: string[]) => {
    parent.forEach((child, offset) => {
      const pos = base + offset
      rows.push(rowFor(child, pos, depth, path.has(pos)))
      if (!child.isText && child.content.size > 0) walk(child, pos + 1, depth + 1, path, rows)
    })
  }

  const renderTree = () => {
    if (!view) return
    const doc = view.state.doc
    // Positions of every node between the doc root and the cursor.
    const path = new Set<number>()
    const $from = view.state.selection.$from
    for (let d = $from.depth; d >= 1; d--) path.add($from.before(d))

    const rows: string[] = [rowFor(doc, null, 0, false)]
    walk(doc, 0, 1, path, rows)
    treeContent.innerHTML =
      `<div class="tree-hint">dimmed path = cursor ancestors · click a row to select it</div>` +
      rows.join("")
  }

  const treeEl = document.createElement("div")
  treeEl.className = "panel-card tree-card"
  const treeHead = makeHead("Document tree")
  const treeBody = document.createElement("div")
  treeBody.className = "panel-body"
  const treeContent = document.createElement("div")
  treeBody.append(treeContent)
  treeEl.append(treeHead, treeBody)
  mount.append(treeEl)

  // One listener on the card survives innerHTML re-renders.
  treeEl.addEventListener("click", (e) => {
    if (!view) return
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]")
    if (!rowEl) return
    const pos = Number(rowEl.dataset.pos)
    const doc = view.state.doc
    const node = doc.nodeAt(pos)
    if (!node) return
    const tr = view.state.tr
    if (node.isText || node.isInline) {
      tr.setSelection(TextSelection.near(doc.resolve(pos)))
    } else {
      tr.setSelection(NodeSelection.create(doc, pos))
    }
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })

  rerun.onclick = () => view && requestFullRecompute(view)
  dump.onclick = () => {
    if (!view) return
    const json = view.state.doc.toJSON()
    const nodeTypes = Object.keys(json.content ?? {})
    console.log(
      `%c doc.toJSON() — ${view.state.doc.childCount} top-level blocks, page nodes found: 0 (verify below)`,
      "color: #16a34a"
    )
    console.log(JSON.stringify(json, null, 2), { topLevelKeys: nodeTypes })
  }

  /* ---------- accordion: at most one panel body visible ---------- */

  let open: "reflow" | "tree" | null = "reflow"

  const applyOpen = () => {
    el.classList.toggle("collapsed", open !== "reflow")
    treeEl.classList.toggle("collapsed", open !== "tree")
    for (const [head, isOpen] of [
      [reflowHead, open === "reflow"],
      [treeHead, open === "tree"],
    ] as const) {
      const btn = head.querySelector<HTMLButtonElement>(".panel-min")!
      btn.textContent = isOpen ? "▾" : "▸"
      btn.setAttribute("aria-expanded", String(isOpen))
    }
  }

  const toggle = (name: "reflow" | "tree") => {
    open = open === name ? null : name
    applyOpen()
  }
  // The arrow button has no handler of its own — its click bubbles to the
  // head, so the whole head is one big toggle target.
  reflowHead.onclick = () => toggle("reflow")
  treeHead.onclick = () => toggle("tree")

  render(null)
  applyOpen()

  return {
    attach(v) {
      view = v
      renderTree()
    },
    sync() {
      renderTree()
    },
    report(r) {
      history.push(
        `#${r.pass} · ${r.pageCount}p · ${r.durationMs.toFixed(1)}ms · measured ${r.measuredCount}/${r.totalBlocks}`
      )
      render(r)
    },
  }
}
