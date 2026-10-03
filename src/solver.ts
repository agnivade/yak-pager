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
 *  - A block that carries `splits` (a paragraph, from MEASURE) can break at a
 *    line boundary instead of moving whole: when it would overflow, the last
 *    line boundary that fits ends the page and the rest of the paragraph
 *    continues on the next page. A paragraph taller than a full page simply
 *    spans several pages. Widow/orphan minimums bound every split: at least
 *    MIN_KEPT_LINES lines must stay behind and MIN_CARRIED_LINES lines must
 *    move, or the paragraph falls back to being pushed whole.
 *  - A block with no usable split is pushed whole when the page is not empty
 *    ("ragged bottoms are expected"). The `h > 0` guard means an oversized
 *    atomic block gets a page to itself rather than a loop.
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

/** Fewest lines that must stay behind a split (orphan control). */
export const MIN_KEPT_LINES = 1
/** Fewest lines that must move to the new page (widow control). */
export const MIN_CARRIED_LINES = 1

export interface Block {
  /** Doc position of the block's start. */
  pos: number
  /** Measured rendered height in px. */
  height: number
  /**
   * Line-boundary split candidates, ascending by height, one per visual
   * line after the first (so length + 1 is the paragraph's line count).
   * Present only for splittable blocks — paragraphs, from MEASURE.
   */
  splits?: SplitCandidate[]
}

export interface SplitCandidate {
  /** Doc position where the carried part starts — inline, a word boundary. */
  pos: number
  /**
   * Height from the block's top to the carried line's LINE-BOX top, in the
   * same px units as Block.height. A gap widget inserted at `pos` gets its
   * top edge exactly here, which is what makes the next page's landing
   * pixel-exact (verified by tests/spike.mjs).
   */
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

/**
 * The last candidate that fits: keep as many lines as possible. Search from
 * the top of the allowed range downward and stop at the first fit.
 *
 * Widow/orphan bounds: candidate k keeps k - segIdx lines on the current
 * page (segIdx is the candidate used by this block's previous split, -1
 * before the first) and carries splits.length - k lines, since
 * splits.length + 1 is the paragraph's line count.
 */
function pickSplit(
  splits: SplitCandidate[],
  segIdx: number,
  placed: number,
  room: number
): { cand: SplitCandidate; index: number } | undefined {
  for (let k = splits.length - MIN_CARRIED_LINES; k >= segIdx + MIN_KEPT_LINES; k--) {
    if (splits[k].height - placed <= room) return { cand: splits[k], index: k }
  }
  return undefined
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

    // Place one block, splitting at line boundaries when it can (and must).
    // `placed`, `segPos` and `segIdx` describe the part not yet on a page.
    let placed = 0 // height already sitting on earlier pages
    let segPos = b.pos // doc pos where the un-placed part starts
    let segIdx = -1 // index of the candidate used by the previous split
    for (;;) {
      const rest = b.height - placed
      if (h + rest <= pageHeight) {
        h += rest
        break
      }

      // Natural split: this part overflows and a line boundary fits.
      const s = b.splits ? pickSplit(b.splits, segIdx, placed, pageHeight - h) : undefined
      if (s) {
        const fill = h + (s.cand.height - placed)
        breaks.push({ pos: s.cand.pos, remaining: pageHeight - fill })
        fills.push(fill)
        start += pageHeight + BAND // a split never overflows: fill <= pageHeight
        pageStarts.push(start)
        h = 0
        placed = s.cand.height
        segPos = s.cand.pos
        segIdx = s.index
        continue // the carried part may split again
      }

      // No split available (atomic block, or nothing fits the minimums):
      // push the rest whole — or, on an empty page, place it anyway so an
      // oversized atomic block gets a page to itself rather than a loop.
      if (h > 0) {
        breaks.push({ pos: segPos, remaining: Math.max(0, pageHeight - h) })
        fills.push(h)
        start += Math.max(h, pageHeight) + BAND
        pageStarts.push(start)
        h = 0
      }
      h += rest
      break
    }

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
