/**
 * (a) MEASURE helpers — batched DOM reads only.
 *
 * Measure one block: its height (minus any gap widgets already inside it)
 * plus, for paragraphs, the line-boundary split candidates the solver uses.
 * Split positions are stored RELATIVE to the paragraph's content start, so
 * a cached measurement stays correct when insertions elsewhere in the
 * document shift the paragraph's doc positions.
 */
import type { EditorView } from "prosemirror-view"
import type { Node as PMNode } from "prosemirror-model"
import type { SplitCandidate } from "./solver"

/**
 * One measured top-level block: height plus, for paragraphs, split
 * candidates. Split positions are stored RELATIVE to the paragraph's
 * content start: a cache hit after an insertion elsewhere in the document
 * must survive it, and doc positions inside the node shift while the
 * node-local offsets do not. runPass converts them back to absolute doc
 * positions with the block's current offset.
 */
export interface MeasuredBlock {
  height: number
  splitCandidates: SplitCandidate[] | null
}

/**
 * Measure one block. Two things make this re-runnable on a paragraph that
 * already contains its own gap widget (which is every paragraph that
 * currently straddles a page — the widget stays in the DOM between passes):
 *
 *  1. The widget's box is inter-page space, not paragraph content, so its
 *     height is subtracted from the block's rect. Without this, pass N+1
 *     would see a taller paragraph than pass N and move the break — the
 *     opposite of idempotence.
 *  2. Words below the widget sit lower than the paragraph's own layout
 *     puts them; measureSplitCandidates subtracts the widget space above
 *     each line, so candidates describe the paragraph as if it were not
 *     split and pass N+1 reproduces the same numbers.
 */
export function measureBlock(
  view: EditorView,
  el: HTMLElement | null,
  node: PMNode,
  contentStart: number
): MeasuredBlock {
  if (!el) return { height: 0, splitCandidates: null }
  const rect = el.getBoundingClientRect()
  const widgetRects = Array.from(
    el.querySelectorAll<HTMLElement>(".page-gap"),
    (w) => w.getBoundingClientRect()
  )
  let height = rect.height
  for (const r of widgetRects) height -= r.height
  const splits =
    node.type.name === "paragraph"
      ? measureSplitCandidates(view, el, rect, widgetRects, contentStart)
      : null
  return { height, splitCandidates: splits }
}

/** A word's rendered rect plus where it lives in the DOM. */
interface WordRect {
  node: Text
  start: number
  rect: DOMRect
}

/**
 * All words in a paragraph with their rects, in document order. Text inside
 * gap widgets is skipped: the widget's page number is decoration, not
 * content, and MEASURE must never read it as a word.
 */
function paragraphWords(el: HTMLElement): WordRect[] {
  const out: WordRect[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(".page-gap")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const t of texts) {
    const s = t.nodeValue ?? ""
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const r = document.createRange()
      r.setStart(t, m.index)
      r.setEnd(t, m.index + m[0].length)
      out.push({ node: t, start: m.index, rect: r.getBoundingClientRect() })
    }
  }
  return out
}

/** One visual line of a paragraph: its top edge and its first word. */
interface LineRect {
  top: number
  firstWord: WordRect
}

/**
 * Group words into visual lines, keeping each line's top edge (the highest
 * word top — baseline alignment puts a larger font higher) and first word.
 * Two words share a line when their rects overlap vertically by more than
 * half the shorter one, which stays correct when a font-size mark shares a
 * line with normal text.
 */
function lineRects(el: HTMLElement): LineRect[] {
  const words = paragraphWords(el)
  const sorted = [...words].sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left
  )
  const lines: WordRect[][] = []
  for (const w of sorted) {
    const cur = lines[lines.length - 1]
    if (cur) {
      const top = Math.min(...cur.map((x) => x.rect.top))
      const bottom = Math.max(...cur.map((x) => x.rect.bottom))
      const overlap = Math.min(bottom, w.rect.bottom) - Math.max(top, w.rect.top)
      if (overlap > 0.5 * Math.min(w.rect.bottom - w.rect.top, bottom - top)) {
        cur.push(w)
        continue
      }
    }
    lines.push([w])
  }
  return lines.map((ws) => ({
    top: Math.min(...ws.map((w) => w.rect.top)),
    firstWord: ws.reduce((a, b) => (b.rect.left < a.rect.left ? b : a)),
  }))
}

/**
 * Line-boundary split candidates for one paragraph, in reading order: for
 * every visual line after the first, the doc position of the line's first
 * word and the height from the paragraph's top to that line's LINE-BOX top.
 *
 * Why the line-box top and not the word's rect top: the widget renders as a
 * float, and the browser places a float's top edge exactly at the carried
 * line's line-box top (verified by tests/spike.mjs). Reporting that same
 * quantity is what makes the carried line land pixel-exactly on the next
 * page's content start. The line-box top is the highest em-box top on the
 * line minus the paragraph's half-leading, which is measured from the
 * first line: its line box starts at the paragraph's content top. For a
 * line whose own font is larger than the paragraph's, this is off by the
 * extra leading — a few px at most, and only when a font-size mark is
 * carried onto the new page.
 */
function measureSplitCandidates(
  view: EditorView,
  el: HTMLElement,
  pRect: DOMRect,
  widgetRects: DOMRect[],
  contentStart: number
): SplitCandidate[] | null {
  const lines = lineRects(el)
  if (lines.length < 2) return null

  /** Widget space sitting above a given viewport y — subtracted from the
   *  heights of every line below it. A widget's top edge sits above the em
   *  boxes of the line it carries, so `r.top < top` separates cleanly. */
  const widgetOffset = (top: number) => {
    let off = 0
    for (const r of widgetRects) if (r.top < top) off += r.height
    return off
  }

  const leading = lines[0].top - pRect.top - widgetOffset(lines[0].top)
  const out: SplitCandidate[] = []
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i]
    out.push({
      // Node-local offset: contentStart is added back in runPass, so a
      // cached candidate stays correct when insertions elsewhere shift
      // the paragraph's doc positions.
      pos: view.posAtDOM(L.firstWord.node, L.firstWord.start) - contentStart,
      height: L.top - pRect.top - widgetOffset(L.top) - leading,
    })
  }
  return out
}
