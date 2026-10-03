/**
 * PAGINATION PLUGIN — three separable pieces:
 *
 *   (a) MEASURE  walk top-level blocks, read heights (batched DOM reads,
 *                cache in a WeakMap keyed by Node identity), invalidate only
 *                the transaction's changed range via tr.mapping. Paragraphs
 *                additionally report their line boundaries as split
 *                candidates for the solver.
 *   (b) SOLVE    pure — see solver.ts. Never touches the DOM.
 *   (c) DECORATE turn break positions into a DecorationSet: one pooled gap
 *                widget per break — between two blocks, or between two
 *                words when the break splits a paragraph. The widget's box
 *                (calc(216px + var(--push)) in CSS) is the entire
 *                inter-page space — band plus ragged bottom — so no block
 *                DOM is ever touched. It is moved with insertBefore when a
 *                break moves.
 *
 * Scheduling: apply() only does position bookkeeping — it NEVER reads the
 * DOM, because it runs inside the transaction. The plugin's view marks
 * nothing more than "dirty" and schedules a rAF pass debounced ~100ms.
 * The pass batches all reads first, solves on pure numbers, then applies
 * everything in ONE meta-transaction. That transaction carries no steps, so
 * it never enters history: Ctrl+Z undoes typing, never pagination.
 *
 * A MutationObserver brackets the dispatch to record every DOM operation
 * the reflow performed — the empirical rule-3 log shown in the dev panel.
 */
import { Plugin, PluginKey } from "prosemirror-state"
import type { Transaction, EditorState } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import type { EditorView } from "prosemirror-view"
import type { Node as PMNode } from "prosemirror-model"
import { solve } from "./solver"
import type { SplitCandidate } from "./solver"
import { CONTENT_H, makeGapWidgetDOM, paintSheets, setPush } from "./layout"
import { measureBlock } from "./measure"
import type { MeasuredBlock } from "./measure"

export interface BreakInfo {
  /**
   * Doc position of the first content on the new page (where the widget is
   * drawn): a block start, or a word inside a paragraph when the break
   * splits it.
   */
  pos: number
  /** Ragged space left on the page above — the push, carried by the widget. */
  remaining: number
}

export interface PaginationState {
  decos: DecorationSet
  breaks: BreakInfo[]
  pageCount: number
  /** Doc-coordinate range that must be re-measured before the next solve. */
  dirty: { from: number; to: number } | null
}

export type OpKind =
  | "setAttribute"
  | "removeAttribute"
  | "insertBefore"
  | "create"
  | "remove"
  | "other"

export interface ReflowOps {
  setAttribute: number
  removeAttribute: number
  insertBefore: number
  create: number
  remove: number
  other: number
}

export interface ReflowReport {
  pass: number
  pageCount: number
  breakPositions: number[]
  remainders: number[]
  durationMs: number
  measuredCount: number
  totalBlocks: number
  fullRecompute: boolean
  ops: Array<{ kind: OpKind; text: string }>
  counts: ReflowOps
}

export const paginationKey = new PluginKey<PaginationState>("pagination")

/** Meta: the rAF pass reports fresh layout (no steps — invisible to history). */
interface LayoutMeta {
  type: "layout"
  breaks: BreakInfo[]
  pageCount: number
  pageStarts: number[]
  fills: number[]
}
/** Meta: fonts/resize/image — re-measure everything (heights can change without the doc changing). */
interface FullMeta {
  type: "full"
}

export function requestFullRecompute(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(paginationKey, { type: "full" } satisfies FullMeta))
}

/* ------------------------------------------------------------------ */
/* Position bookkeeping (pure — runs inside transactions)              */
/* ------------------------------------------------------------------ */

/**
 * Union of the positions a transaction's steps touched, in FINAL doc
 * coordinates.
 */
function changedRange(tr: Transaction): { from: number; to: number } | null {
  if (!tr.docChanged) return null
  let from = Infinity
  let to = -Infinity
  tr.mapping.maps.forEach((map, i) => {
    // forEach gives each changed range in this step's coordinates:
    // old ones pre-step, new ones post-step.
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const after = tr.mapping.slice(i + 1)
      from = Math.min(from, after.map(newStart, -1))
      to = Math.max(to, after.map(newEnd, 1))
    })
  })
  return from === Infinity ? null : { from, to: Math.max(to, from) }
}

function remapRange(r: { from: number; to: number } | null, tr: Transaction) {
  if (!r) return null
  return { from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) }
}

function unionRange(
  a: { from: number; to: number } | null,
  b: { from: number; to: number } | null
): { from: number; to: number } | null {
  if (!a) return b
  if (!b) return a
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

export function paginationPlugin(options: { onReflow?: (report: ReflowReport) => void } = {}) {
  // Per-editor resources shared by state.apply and the view code below.
  // The widget pool is what "the single reused page-gap widget" means
  // concretely: element i is created once and re-inserted forever after.
  const pool = new Map<number, HTMLElement>()
  // Purely needed for the devPanel to get the right info.
  // Nothing to do with the core pagination.
  const createdThisPass = new Set<HTMLElement>()
  let passCount = 0

  const takeFromPool = (i: number) => {
    let el = pool.get(i)
    if (!el) {
      el = makeGapWidgetDOM(i)
      pool.set(i, el)
      createdThisPass.add(el)
    } else {
      // The break moved and PM is re-creating this widget's desc while the
      // pooled element is still attached at the OLD position. Detach it
      // here: renderDescs then inserts it at the new position with one
      // insertBefore. Left attached, renderDescs would instead "walk" the
      // DOM cursor to the old position by removing and re-inserting every
      // block in between — exactly the churn rule 3 forbids.
      el.remove()
    }
    return el
  }

  return new Plugin<PaginationState>({
    key: paginationKey,

    state: {
      init: (): PaginationState => ({
        decos: DecorationSet.empty,
        breaks: [],
        pageCount: 1,
        dirty: null,
      }),

      /**
       * Pure position bookkeeping. Two jobs:
       *  1. Keep stored positions valid: decorations map themselves through
       *     tr.mapping; the dirty range is remapped the same way.
       *  2. Widen the dirty range by whatever this transaction changed, or
       *     replace the layout entirely when the rAF pass reports in.
       */
      apply(tr: Transaction, prev: PaginationState): PaginationState {
        if (tr.getMeta(paginationKey) != null && (tr.getMeta(paginationKey) as FullMeta).type === "full") {
          return {
            ...prev,
            decos: prev.decos.map(tr.mapping, tr.doc),
            dirty: { from: 0, to: tr.doc.content.size },
          }
        }

        // We need both remapRange and changedRange because the UI doesn't get updated
        // for every transaction. The runPass is scheduled only once in 100ms, so multiple transactions
        // might have happened before the call. Therefore, we need to find out the changes
        // in the current transaction as well as combine them with the previous transactions.
        const dirty = unionRange(remapRange(prev.dirty, tr), changedRange(tr))
        let next: PaginationState = { ...prev, decos: prev.decos.map(tr.mapping, tr.doc), dirty }

        const meta = tr.getMeta(paginationKey) as LayoutMeta | undefined
        // This is a layout signal from runPass.
        // We set the new widget decorations and wipe off the dirty state.
        if (meta && meta.type === "layout") {
          const widgets = meta.breaks.map((b, i) =>
            Decoration.widget(b.pos, () => takeFromPool(i), {
              key: `page-gap-${i}`,
              side: -1,
              marks: [],
            })
          )
          next = {
            ...next,
            breaks: meta.breaks,
            pageCount: meta.pageCount,
            decos: DecorationSet.create(tr.doc, widgets),
            dirty: null,
          }
        }
        return next
      },
    },

    props: {
      decorations(state: EditorState) {
        return paginationKey.getState(state)!.decos
      },
    },

    view(editorView: EditorView) {
      const view = editorView
      const stack = view.dom.parentElement as HTMLElement
      if (!stack) throw new Error("paginationPlugin: editor must be mounted inside .paper-stack")

      // MEASURE cache — keyed by Node object identity. PM nodes are
      // immutable values: editing a paragraph produces a *different* Node,
      // while untouched blocks keep theirs across the transaction.
      const cache = new WeakMap<PMNode, MeasuredBlock>()

      let timer: ReturnType<typeof setTimeout> | null = null
      let raf: number | null = null
      let pendingFull = false
      let destroyed = false

      // This is needed to pass info to the devPanel
      const mo = new MutationObserver(() => {})
      mo.observe(stack, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
      })

      const schedule = (full = false) => {
        if (destroyed) return
        if (full) pendingFull = true
        if (raf != null) return
        if (timer != null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          raf = requestAnimationFrame(() => {
            raf = null
            runPass()
          })
        }, 100)
      }

      const gapName = (el: HTMLElement) => `.page-gap-${el.dataset.page}`

      const classify = (records: MutationRecord[]) => {
        const ops: Array<{ kind: OpKind; text: string }> = []
        const counts: ReflowOps = {
          setAttribute: 0,
          removeAttribute: 0,
          insertBefore: 0,
          create: 0,
          remove: 0,
          other: 0,
        }

        // Widgets first: a move can surface as one record (node in both
        // added and removed) or as separate remove+add records, so reduce
        // to a net disposition per element before classifying.
        const net = new Map<HTMLElement, { added: boolean; removed: boolean }>()
        const otherChildList: MutationRecord[] = []
        const textSplits: MutationRecord[] = []
        for (const r of records) {
          if (r.type !== "childList") continue
          // Moving a widget that sits between two words re-splits the
          // paragraph's text nodes around the new position — a few #text
          // nodes appear and disappear while no element changes. That is
          // part of the move, not churn, so it counts as an insertBefore
          // (the paragraph element and its content keep their identity).
          const nodes = [...r.addedNodes, ...r.removedNodes]
          const allText = nodes.length > 0 && nodes.every((n) => n.nodeType === 3)
          if (allText) {
            textSplits.push(r)
            continue
          }
          const gaps = nodes.filter(
            (n): n is HTMLElement =>
              n instanceof HTMLElement && n.classList.contains("page-gap")
          )
          if (gaps.length === 0) otherChildList.push(r)
          for (const g of gaps) {
            const d = net.get(g) ?? { added: false, removed: false }
            if (Array.from(r.addedNodes).includes(g)) d.added = true
            if (Array.from(r.removedNodes).includes(g)) d.removed = true
            net.set(g, d)
          }
        }
        for (const [el, d] of net) {
          if (d.removed && !d.added) {
            ops.push({ kind: "remove", text: `remove ${gapName(el)} (page count shrank)` })
          } else if (d.added && !d.removed && createdThisPass.has(el)) {
            ops.push({ kind: "create", text: `create ${gapName(el)} (page count grew)` })
          } else {
            ops.push({
              kind: "insertBefore",
              text: `insertBefore ${gapName(el)} (element reused, not rebuilt)`,
            })
          }
        }
        for (const r of textSplits) {
          ops.push({
            kind: "insertBefore",
            text: `re-split #text in ${(r.target as HTMLElement).nodeName.toLowerCase()} (inline widget moved)`,
          })
        }

        // Attribute records: prosemirror-view patches a style decoration by
        // removing the old properties and then appending the new value, so
        // one logical change can appear as two records. Collapse per
        // (element, attribute) to the logical operation: firstOldValue →
        // the element's CURRENT value, which is the final state of the
        // window (classify runs in the same synchronous frame).
        const seen = new Map<HTMLElement, Map<string, string | null>>()
        for (const r of records) {
          if (r.type !== "attributes") continue
          const t = r.target as HTMLElement
          let m = seen.get(t)
          if (!m) seen.set(t, (m = new Map()))
          if (!m.has(r.attributeName!)) m.set(r.attributeName!, r.oldValue)
        }
        for (const [t, attrs] of seen) {
          for (const [name, firstOld] of attrs) {
            const final = t.getAttribute(name)
            // Skip no-op writes (oldValue == current value): PM
            // unconditionally re-sets some attributes (e.g. the
            // ProseMirror-widget class) when re-creating widget descs.
            if (firstOld != null && firstOld === final) continue
            if (t === stack) {
              ops.push({
                kind: "setAttribute",
                text: `setAttribute ${name} on .paper-stack (scaffold, not content)`,
              })
            } else if (t.classList?.contains("page-gap")) {
              ops.push({
                kind: "setAttribute",
                text: `setAttribute ${name}="${final ?? ""}" on ${gapName(t)} (${name === "style" ? "--push" : "housekeeping"})`,
              })
            } else if (name === "style" && t.parentElement === view.dom) {
              const hadBefore = firstOld != null && firstOld.includes("margin-top")
              const hasNow = final != null && final.includes("margin-top")
              if (hasNow) {
                ops.push({
                  kind: "setAttribute",
                  text: `setAttribute style "${final}" on ${t.nodeName.toLowerCase()} (push to next page)`,
                })
              } else if (hadBefore) {
                ops.push({
                  kind: "removeAttribute",
                  text: `removeAttribute style on ${t.nodeName.toLowerCase()} (no longer after a break)`,
                })
              }
            } else {
              ops.push({ kind: "other", text: `attribute ${name} on ${t.nodeName}` })
            }
          }
        }
        for (const r of otherChildList) {
          const n = r.addedNodes[0] ?? r.removedNodes[0]
          ops.push({
            kind: "other",
            text: `childList ${r.addedNodes.length ? "+" : "-"}${n?.nodeName ?? "?"} under ${r.target.nodeName}`,
          })
        }

        for (const op of ops) counts[op.kind]++
        return { ops, counts }
      }

      const runPass = () => {
        if (destroyed) return
        const state = paginationKey.getState(view.state)!
        const full = pendingFull
        pendingFull = false
        // Idempotence guard: with no dirty range and nothing new to measure,
        // a pass must do nothing at all.
        if (!full && state.dirty == null && passCount > 0) return
        createdThisPass.clear()
        const t0 = performance.now()

        // -------- (a) MEASURE: batched DOM reads, then nothing but reads --
        // All getBoundingClientRect calls happen before any write, so the
        // browser performs layout once, not interleaved read/write cycles.
        const blockEls = topBlockElements(view.dom)
        const blocks: { pos: number; end: number; height: number; forced: boolean; splitCandidates?: SplitCandidate[] }[] = []
        let measured = 0
        let i = 0
        view.state.doc.forEach((node: PMNode, offset: number) => {
          const el = blockEls[i++]
          const pos = offset
          const end = offset + node.nodeSize
          const contentStart = offset + 1 // past the block's opening token
          const inDirty = state.dirty != null && pos < state.dirty.to && end > state.dirty.from
          let m = cache.get(node)
          if (full || m === undefined || inDirty) {
            // getBoundingClientRect().height, not offsetHeight: offsetHeight
            // rounds to integers and the error accumulates across a page.
            m = measureBlock(view, el, node, contentStart)
            cache.set(node, m)
            measured++
          }
          // measureBlock also returns split candidates.
          // This is needed by the solved to correctly split a node if needed.
          // But these positions are local to a node, so we make it absolute here.
          const splitCandidates =
            m.splitCandidates?.map((s) => ({ pos: contentStart + s.pos, height: s.height })) ??
            undefined
          blocks.push({
            pos,
            end,
            height: m.height,
            forced: node.type.name === "pageBreak",
            splitCandidates: splitCandidates,
          })
        })

        // -------- (b) SOLVE: pure, on numbers only ------------------------
        const { breaks: solved, pageStarts, fills } = solve(
          blocks.map((b) => ({ pos: b.pos, height: b.height, splits: b.splitCandidates })),
          CONTENT_H,
          blocks.filter((b) => b.forced).map((b) => b.pos)
        )
        const breaks: BreakInfo[] = solved.map((s) => ({
          pos: s.pos,
          remaining: s.remaining,
        }))

        // -------- (c) DECORATE: one meta-transaction ----------------------
        mo.takeRecords() // discard anything before this point
        paintSheets(stack, pageStarts, fills)
        view.dispatch(
          view.state.tr.setMeta(paginationKey, {
            type: "layout",
            breaks,
            pageCount: breaks.length + 1,
            pageStarts,
            fills,
          } satisfies LayoutMeta)
        )
        // Sync the widget visuals (--push). PM ignores mutations on
        // widgets (ignoreMutation), so these writes never trigger DOM
        // reconciliation. Every write is change-checked: a stable layout
        // performs zero DOM operations.
        syncView(breaks, pool)
        const records = mo.takeRecords()
        const t1 = performance.now()

        const { ops, counts } = classify(records)
        passCount++
        options.onReflow?.({
          pass: passCount,
          pageCount: breaks.length + 1,
          breakPositions: breaks.map((b) => b.pos),
          remainders: breaks.map((b) => b.remaining),
          durationMs: t1 - t0,
          measuredCount: measured,
          totalBlocks: blocks.length,
          fullRecompute: full,
          ops,
          counts,
        })
      }

      return {
        update() {
          const s = paginationKey.getState(view.state)!
          if (s.dirty != null) schedule()
        },
        destroy() {
          destroyed = true
          if (timer != null) clearTimeout(timer)
          if (raf != null) cancelAnimationFrame(raf)
          mo.disconnect()
          for (const el of pool.values()) el.remove()
          pool.clear()
        },
      }
    },
  })
}

/**
 * Top-level block DOM elements, in document order, with gap widgets skipped.
 */
function topBlockElements(dom: HTMLElement): (HTMLElement | null)[] {
  const out: (HTMLElement | null)[] = []
  for (const n of Array.from(dom.childNodes)) {
    if (n instanceof Text) {
      if (n.textContent && n.textContent.trim() !== "") {
        console.warn("pagination: stray text node at top level")
        out.push(null)
      }
      continue
    }
    if (!(n instanceof HTMLElement)) continue
    if (n.classList.contains("page-gap")) continue
    out.push(n)
  }
  return out
}

/**
 * Align the view with the computed layout: point each pooled widget's --push
 * at the fresh `remaining`. The widget's own box height derives from --push
 * in CSS (calc(216px + var(--push))), so this one write IS the push. Writes
 * are change-checked, so an unchanged layout performs zero DOM operations.
 */
function syncView(breaks: BreakInfo[], pool: Map<number, HTMLElement>) {
  breaks.forEach((b, i) => {
    const w = pool.get(i)
    if (w) setPush(w, b.remaining)
  })
}
