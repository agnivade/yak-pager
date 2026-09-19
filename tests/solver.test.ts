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
