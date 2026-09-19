/**
 * SOLVE — the pure core of pagination.
 *
 * Input: measured block heights + doc positions. Output: where pages break.
 * No DOM, no ProseMirror, no clocks, no randomness: same input, same output.
 * That is what makes it unit-testable with synthetic height arrays
 * (tests/solver.test.ts) and what keeps reflow idempotent — running the pass
 * twice over the same measurements produces the same decorations, so the
 * second run writes nothing to the DOM.
 *
 * Rules:
 *  - Blocks stack in order; each page holds up to `pageHeight` of content.
 *  - When a block would overflow a non-empty page, it starts a new page
 *    instead ("pushed whole" — no mid-paragraph splitting; ragged bottoms
 *    are expected). The `h > 0` guard means the first block never breaks
 *    and an oversized block gets a page to itself rather than a loop.
 *  - A forced break (an explicit `pageBreak` node) ends its page after the
 *    marker itself renders, regardless of remaining space. Two consecutive
 *    forced breaks therefore produce a blank page — that is authorial
 *    intent, so it is honored.
 *
 * The return value carries more than bare positions: `remaining` is what the
 * decorate step needs for the margin-top push, and `pageStarts`/`fills` are
 * what the view needs to paint sheets. Deriving them here keeps the
 * accumulation logic in exactly one pure place.
 */

/** Visual height of the band between two pages: bottom margin + desk gap + top margin. */
export const BAND = 216

export interface Block {
  /** Doc position of the block's start. */
  pos: number
  /** Measured rendered height in px. */
  height: number
}

export interface PageBreak {
  /** Doc position of the first block on the new page. */
  pos: number
  /** Ragged space left on the page above (>= 0). */
  remaining: number
}

export interface Solution {
  breaks: PageBreak[]
  /**
   * Flow-space y where each page's first content pixel sits (index 0 = page
   * 1). A page that overflows extends the flow: page k+1 starts at
   * start_k + max(fill_k, pageHeight) + BAND.
   */
  pageStarts: number[]
  /** Content height on each page. */
  fills: number[]
}

export function solve(blocks: Block[], pageHeight: number, forcedBreaks: number[] = []): Solution {
  const forced = new Set(forcedBreaks)
  const breaks: PageBreak[] = []
  const pageStarts: number[] = [0]
  const fills: number[] = []
  let h = 0 // fill of the current page
  let start = 0 // flow y where the current page's content began

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]

    // Natural break: this block does not fit and the page is not empty.
    if (h > 0 && h + b.height > pageHeight) {
      breaks.push({ pos: b.pos, remaining: Math.max(0, pageHeight - h) })
      fills.push(h)
      start += Math.max(h, pageHeight) + BAND
      pageStarts.push(start)
      h = 0
    }
    h += b.height

    // Forced break: the marker renders on the current page, then the next
    // content begins a fresh page even if this one had room.
    if (forced.has(b.pos) && i + 1 < blocks.length) {
      breaks.push({ pos: blocks[i + 1].pos, remaining: Math.max(0, pageHeight - h) })
      fills.push(h)
      start += Math.max(h, pageHeight) + BAND
      pageStarts.push(start)
      h = 0
    }
  }
  fills.push(h)
  return { breaks, pageStarts, fills }
}
