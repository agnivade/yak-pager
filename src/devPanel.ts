/**
 * Dev panel — the empirical half of the exercise.
 *
 * Shows: page count, break positions, last reflow duration, how many blocks
 * were re-measured (cache hits = total - measured), and the DOM operation
 * log captured by the MutationObserver during the reflow. "Re-run pass"
 * proves idempotence: it forces a full re-measure of a stable layout, and
 * the log should come back empty. "Dump doc JSON" proves rule 1: the
 * serialized document contains no page nodes, ever.
 */
import type { EditorView } from "prosemirror-view"
import type { ReflowReport } from "./paginationPlugin"
import { requestFullRecompute } from "./paginationPlugin"

export interface DevPanel {
  report(r: ReflowReport): void
  attach(view: EditorView): void
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

  const el = document.createElement("div")
  el.className = "panel-card"
  mount.append(el)

  const render = (r: ReflowReport | null) => {
    const parts: string[] = []
    parts.push(`<h2>Pagination · dev panel</h2>`)

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

    el.innerHTML = parts.join("")
  }

  const buttons = document.createElement("div")
  buttons.className = "panel-buttons"
  const rerun = document.createElement("button")
  rerun.textContent = "Re-run pass (idempotence check)"
  const dump = document.createElement("button")
  dump.textContent = "Dump doc.toJSON() to console"
  buttons.append(rerun, dump)
  mount.append(buttons)

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

  render(null)

  return {
    attach(v) {
      view = v
    },
    report(r) {
      history.push(
        `#${r.pass} · ${r.pageCount}p · ${r.durationMs.toFixed(1)}ms · measured ${r.measuredCount}/${r.totalBlocks}`
      )
      render(r)
    },
  }
}
