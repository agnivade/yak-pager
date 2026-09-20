import { describe, it, expect } from "vitest"
import { solve, BAND } from "../src/solver"

// Synthetic block factory: heights chosen to exercise the accumulator.
// Positions are arbitrary doc coordinates of the same order as the heights.
const blocks = (heights: number[]) =>
  heights.map((height, i) => ({ pos: i * 10, height }))

const PAGE = 864

describe("solve", () => {
  it("no overflow: a single page, no breaks", () => {
    const r = solve(blocks([100, 200, 300, 264]), PAGE)
    expect(r.breaks).toEqual([])
    expect(r.pageStarts).toEqual([0])
    expect(r.fills).toEqual([864])
  })

  it("no overflow: exact fit does not break (>= is the boundary)", () => {
    const r = solve(blocks([864]), PAGE)
    expect(r.breaks).toEqual([])
    // one block at exactly page height: no break, page exactly full
    const r2 = solve(blocks([432, 432]), PAGE)
    expect(r2.breaks).toEqual([])
    expect(r2.fills).toEqual([864])
  })

  it("single break: block that would overflow starts the next page", () => {
    const r = solve(blocks([800, 200, 100]), PAGE)
    expect(r.breaks).toEqual([{ pos: 10, remaining: 64 }])
    expect(r.pageStarts).toEqual([0, PAGE + BAND])
    expect(r.fills).toEqual([800, 300])
  })

  it("consecutive oversized blocks: each gets a page to itself, remaining clamps to 0", () => {
    const r = solve(blocks([50, 1200, 1300, 40]), PAGE)
    // break before block 1 (50+1200 > 864), before block 2 (1200 > 864
    // already overflows its own page), before block 3.
    expect(r.breaks.map((b) => b.pos)).toEqual([10, 20, 30])
    expect(r.breaks.map((b) => b.remaining)).toEqual([814, 0, 0])
    // Overflowing pages extend the flow period: page 2 starts after the spill.
    //   p1 = max(50, 864) + BAND
    //   p2 = p1 + max(1200, 864) + BAND
    //   p3 = p2 + max(1300, 864) + BAND
    expect(r.pageStarts).toEqual([0, 864 + BAND, 864 + BAND + 1200 + BAND, 864 + BAND + 1200 + BAND + 1300 + BAND])
    expect(r.fills).toEqual([50, 1200, 1300, 40])
  })

  it("forced break: ends the page wherever the marker sits", () => {
    const b = blocks([100, 100, 100, 100])
    const r = solve(b, PAGE, [b[1].pos]) // marker is the second block
    expect(r.breaks).toEqual([{ pos: b[2].pos, remaining: 864 - 200 }])
    expect(r.fills).toEqual([200, 200])
    expect(r.pageStarts).toEqual([0, PAGE + BAND])
  })

  it("forced break as the last block produces no trailing break", () => {
    const b = blocks([100, 50, 60])
    const r = solve(b, PAGE, [b[2].pos])
    expect(r.breaks).toEqual([])
    expect(r.pageStarts).toEqual([0])
  })

  it("two consecutive forced breaks produce a blank page (authorial intent)", () => {
    const b = blocks([40, 20, 20, 30])
    const r = solve(b, PAGE, [b[1].pos, b[2].pos])
    expect(r.breaks.map((x) => x.pos)).toEqual([b[2].pos, b[3].pos])
    expect(r.pageStarts).toEqual([0, PAGE + BAND, 2 * (PAGE + BAND)])
    expect(r.fills).toEqual([60, 20, 30])
  })

  it("empty doc: one empty page, no breaks", () => {
    const r = solve([], PAGE)
    expect(r.breaks).toEqual([])
    expect(r.pageStarts).toEqual([0])
    expect(r.fills).toEqual([0])
  })

  it("first block never breaks even if it is oversized", () => {
    const r = solve(blocks([2000, 100]), PAGE)
    expect(r.breaks).toEqual([{ pos: 10, remaining: 0 }])
    expect(r.fills).toEqual([2000, 100])
  })

  it("natural break lands before a forced marker that no longer fits", () => {
    // Page exactly full (864), then a marker: the marker itself overflows,
    // so a natural break precedes it, and the forced break follows it.
    const b = blocks([864, 20, 50])
    const r = solve(b, PAGE, [b[1].pos])
    expect(r.breaks.map((x) => x.pos)).toEqual([b[1].pos, b[2].pos])
    expect(r.fills).toEqual([864, 20, 50])
  })
})

describe("solve with line splits", () => {
  /** A paragraph of n lines, lineHeight each: candidates at every line
   * boundary after the first, positions 100, 101, 102, ... (arbitrary
   * inline positions ascending with height, as MEASURE produces). */
  const para = (lines: number, lineHeight: number) => ({
    pos: 10,
    height: lines * lineHeight,
    splits: Array.from({ length: lines - 1 }, (_, k) => ({
      pos: 100 + k,
      height: (k + 1) * lineHeight,
    })),
  })

  it("a paragraph that does not fit splits at the last line boundary that fits", () => {
    // Page holds 800, paragraph is 4 lines of 24 (96px). Room is 64, so the
    // boundary at 48 fits (2 lines stay, 2 move) and 72 does not.
    const r = solve([{ pos: 0, height: 800 }, para(4, 24)], PAGE)
    expect(r.breaks).toEqual([{ pos: 101, remaining: 16 }])
    expect(r.fills).toEqual([848, 48])
    expect(r.pageStarts).toEqual([0, PAGE + BAND])
  })

  it("keeps as many lines as the widow rule allows (last fitting candidate wins)", () => {
    // Same paragraph, room for 3 lines (72 of 96). Splitting after 3 lines
    // would carry a single line — a widow — so the split lands one line
    // earlier: 2 stay, 2 move.
    const r = solve([{ pos: 0, height: 792 }, para(4, 24)], PAGE)
    expect(r.breaks.map((b) => b.pos)).toEqual([101])
    expect(r.breaks.map((b) => b.remaining)).toEqual([24])
    expect(r.fills).toEqual([840, 48])
  })

  it("a paragraph taller than a full page splits even on an empty page", () => {
    // 75 lines of 24 = 1800px, alone in the doc: it must span 3 pages.
    const r = solve([para(75, 24)], PAGE)
    // page 1: 36 lines fill exactly 864 → remaining 0
    // page 2: 36 more lines fill exactly 864 → remaining 0
    // page 3: 3 lines
    expect(r.breaks.map((b) => b.pos)).toEqual([100 + 35, 100 + 71])
    expect(r.breaks.map((b) => b.remaining)).toEqual([0, 0])
    expect(r.fills).toEqual([864, 864, 72])
    expect(r.pageStarts).toEqual([0, PAGE + BAND, 2 * (PAGE + BAND)])
  })

  it("widow minimum: a 3-line paragraph never splits (2 would stay, only 1 would move)", () => {
    const r = solve([{ pos: 0, height: 800 }, para(3, 24)], PAGE)
    expect(r.breaks).toEqual([{ pos: 10, remaining: 64 }])
    expect(r.fills).toEqual([800, 72])
  })

  it("orphan minimum: the first line boundary (candidate 0) is never used", () => {
    // Room for 5 of 6 lines: the boundary after line 5 (candidate 4) fits
    // geometrically but would carry a single line (widow), and the one
    // after line 1 (candidate 0) would leave a single line behind
    // (orphan) — the split lands after line 4: 4 stay, 2 move.
    const r = solve([{ pos: 0, height: 744 }, para(6, 24)], PAGE)
    expect(r.breaks.map((b) => b.pos)).toEqual([103])
    expect(r.breaks.map((b) => b.remaining)).toEqual([24])
    expect(r.fills).toEqual([840, 48])
  })

  it("no candidate fits the remaining space → pushed whole (old behavior)", () => {
    // Room 64, lines are 50 tall: no boundary fits, so the whole paragraph
    // moves — the same as an atomic block.
    const r = solve([{ pos: 0, height: 800 }, para(4, 50)], PAGE)
    expect(r.breaks).toEqual([{ pos: 10, remaining: 64 }])
    expect(r.fills).toEqual([800, 200])
  })

  it("a carried remainder can split again with its own widow/orphan bounds", () => {
    // 15 lines of 100 (1500px) after a 400px block. Room 464: boundary at
    // 400 (4 lines) is the last that fits; the carried 11 lines (1100px)
    // overflow page 2 (864), so they split again at line 12 (800 into the
    // segment); the last 3 lines fit page 3.
    const r = solve([{ pos: 0, height: 400 }, para(15, 100)], PAGE)
    expect(r.breaks.map((b) => b.pos)).toEqual([103, 100 + 11])
    expect(r.breaks.map((b) => b.remaining)).toEqual([64, 64])
    expect(r.fills).toEqual([800, 800, 300])
    expect(r.pageStarts).toEqual([0, PAGE + BAND, 2 * (PAGE + BAND)])
  })

  it("empty splits array (single-line paragraph) behaves like an atomic block", () => {
    const r = solve([{ pos: 0, height: 800 }, { pos: 10, height: 100, splits: [] }], PAGE)
    expect(r.breaks).toEqual([{ pos: 10, remaining: 64 }])
    expect(r.fills).toEqual([800, 100])
  })
})
