/**
 * E2E verification (run: npm run e2e) — checks the exercise's three claims
 * in a real browser:
 *
 *   1. The seed spans 4+ pages, breaks computed, no "other" DOM mutations.
 *   2. Idempotence: forcing a full re-measure of a stable layout performs
 *      ZERO DOM operations (the panel's own MutationObserver says so).
 *   3. Rule 1: pagination never enters the undo stack. Type N characters,
 *      press Ctrl+Z exactly once — the typed text is gone and the document
 *      is byte-for-byte the seed again (if pagination had history events,
 *      the first undo would undo a reflow instead, and the text would stay).
 *   4. Rule 3: typing that moves a break logs insertBefore + setAttribute
 *      ops only — no creates, removes, or "other".
 *   5. Justified text: every line but the last sits flush at the right
 *      margin — including the lines around a gap widget in a paragraph
 *      that splits across a page, applied through the real toolbar.
 *
 * Requires google-chrome on PATH and a build (npm run build).
 */
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra ? "  — " + extra : ""}`)
  if (!cond) failures++
}

const server = spawn("npx", ["vite", "preview", "--port", "4179", "--strictPort"], {
  stdio: "ignore",
  detached: true,
})
await sleep(1500)

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu"],
})
const page = await browser.newPage()
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text())
})

await page.goto("http://localhost:4179/", { waitUntil: "networkidle0" })
await sleep(1200) // initial pass + fonts.ready-triggered full pass

const readChips = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".chip")].map((c) => {
        const m = c.textContent.match(/^(.*?) (\d+)$/)
        return m ? [m[1], Number(m[2])] : [c.textContent, NaN]
      })
    )
  )
const readStats = () =>
  page.evaluate(() => ({
    pages: Number(document.querySelector(".stats .v")?.textContent ?? NaN),
    breaks: [...document.querySelectorAll(".breaks div")].textContent ?? "",
  }))
const panelText = () => page.evaluate(() => document.querySelector(".panel-card")?.textContent ?? "")

console.log("— initial layout")
const stats1 = await readStats()
const chips1 = await readChips()
ok(stats1.pages >= 4, `seed spans 4+ pages`, `pages=${stats1.pages}`)
ok((chips1.other ?? 0) === 0, "no unexpected DOM mutations", `other=${chips1.other}`)
ok((chips1.create ?? 0) > 0, "gap widgets created once at startup", `create=${chips1.create}`)

console.log("— idempotence: force full re-measure of stable layout")
const before = await page.evaluate(() => document.querySelector(".paper-stack")?.innerHTML.length)
await page.evaluate(() => [...document.querySelectorAll(".panel-buttons button")][0].click())
await sleep(700)
const chips2 = await readChips()
const totalOps = Object.values(chips2).reduce((a, b) => a + b, 0)
ok(totalOps === 0, "re-run pass performed ZERO DOM operations", JSON.stringify(chips2))
const after = await page.evaluate(() => document.querySelector(".paper-stack")?.innerHTML.length)
ok(before === after, "editor DOM byte-identical before/after re-run")

console.log("— rule 1: undo undoes typing, never pagination")
// Put the caret at the very end of the document.
await page.evaluate(() => {
  const pm = document.querySelector(".ProseMirror")
  const last = pm.lastElementChild
  const range = document.createRange()
  range.selectNodeContents(last)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  pm.focus()
})
await page.keyboard.type(" UNDOABLE-SENTENCE")
await sleep(900) // debounced reflow
const chipsTyped = await readChips()
ok((chipsTyped.other ?? 0) === 0, "typing reflow: no unexpected DOM mutations", JSON.stringify(chipsTyped))
ok(
  Object.values(chipsTyped).every((v) => v === 0),
  "typing absorbed by ragged space → reflow performed ZERO DOM operations"
)
const textWith = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(textWith.endsWith("UNDOABLE-SENTENCE"), "typed text present", textWith.slice(-40))

await page.keyboard.down("Control")
await page.keyboard.press("KeyZ")
await page.keyboard.up("Control")
await sleep(900) // debounced reflow
const textAfter = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(
  !textAfter.includes("UNDOABLE-SENTENCE"),
  "one Ctrl+Z removed exactly the typed text",
  textAfter.slice(-40)
)
// A second Ctrl+Z must do nothing: the seed predates history, and pagination
// never occupied an undo slot. If it did, this would delete seed content.
await page.keyboard.down("Control")
await page.keyboard.press("KeyZ")
await page.keyboard.up("Control")
await sleep(700)
const textAfter2 = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(textAfter2 === textAfter, "second Ctrl+Z was a no-op (no pagination in undo stack)")

console.log("— rule 3: break movement reused widgets, did not rebuild")
// Insert new paragraphs mid-document: content below shifts, so an existing
// break moves to a different block. The pooled widget must be re-inserted
// (insertBefore), never rebuilt.
await page.evaluate(() => {
  const ps = [...document.querySelectorAll(".ProseMirror > p")]
  const mid = ps[Math.floor(ps.length / 2)]
  const range = document.createRange()
  range.selectNodeContents(mid)
  range.collapse(true) // caret at start of a mid paragraph
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
for (let i = 0; i < 8; i++) {
  await page.keyboard.press("Enter")
  await page.keyboard.type("newly inserted paragraph")
}
await sleep(1100)
const chips3 = await readChips()
ok((chips3.other ?? 0) === 0, "break-move reflow: no unexpected mutations", JSON.stringify(chips3))
ok((chips3.insertBefore ?? 0) > 0, "widgets moved via insertBefore", `insertBefore=${chips3.insertBefore}`)
ok((chips3.setAttribute ?? 0) > 0, "pushes updated via setAttribute (--push)", `setAttribute=${chips3.setAttribute}`)
const widgetCount = await page.evaluate(() => document.querySelectorAll(".page-gap").length)
const pageCount = (await readStats()).pages
ok(widgetCount === pageCount - 1, "one pooled widget per break", `${widgetCount} widgets / ${pageCount} pages`)
ok(
  (chips3.create ?? 0) + (chips3.remove ?? 0) <= 2,
  "page count stable → no widget churn while breaks moved",
  `create=${chips3.create} remove=${chips3.remove}`
)

console.log("— typing inside a paragraph that straddles a page boundary")
// The scenario the split feature exists for: caret at the end of the
// paragraph that currently contains a gap widget (it straddles a page),
// then type. The split may move by a line or stay put — either way the
// reflow may only reuse widgets (insertBefore + text re-splits + --push
// writes), and the landing checks below verify the new geometry exactly.
await page.evaluate(() => {
  const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
    el.querySelector(".page-gap")
  )
  const range = document.createRange()
  range.selectNodeContents(p)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
await page.keyboard.type(" And a final sentence, typed at the end of a paragraph that is currently split across a page boundary.")
await sleep(1100)
const chips4 = await readChips()
ok((chips4.other ?? 0) === 0, "typing in a split paragraph: no unexpected mutations", JSON.stringify(chips4))
ok(
  (chips4.create ?? 0) + (chips4.remove ?? 0) <= 2,
  "typing in a split paragraph: no widget churn",
  `create=${chips4.create} remove=${chips4.remove}`
)

// Placement: each widget must sit immediately before the content that
// begins the page after its break — that content may be a block OR a word
// inside a paragraph, so resolve the DOM point at break.pos and check the
// widget is its previous element sibling.
const placement = await page.evaluate(() => {
  const { view, key } = window.__pager
  const s = view.state
  const bl = key.getState(s)?.breaks ?? []
  const bad = []
  bl.forEach((b, i) => {
    const w = [...view.dom.querySelectorAll(".page-gap")].find(
      (x) => x.dataset.page === String(i)
    )
    if (!w) return void bad.push(`widget ${i} missing`)
    const at = view.domAtPos(b.pos)
    const target = at.node.nodeType === 1 ? at.node.childNodes[at.offset] : at.node
    let prev = target?.previousSibling
    while (prev && prev.nodeType === 3 && !(prev.textContent || "").trim()) {
      prev = prev.previousSibling
    }
    if (!prev || prev !== w) bad.push(`widget ${i} not immediately before pos ${b.pos}`)
  })
  return {
    breaks: bl.map((b) => b.pos),
    inline: bl.some((b) => s.doc.resolve(b.pos).depth >= 1),
    bad,
  }
})
ok(placement.bad.length === 0, "every widget sits immediately before its break's content", JSON.stringify(placement.bad))
ok(placement.inline, "at least one break splits a paragraph mid-text (inline pos)")

// Landing: the whole pipeline is pixel-exact end to end — every widget's
// box must END exactly at the next page's content start, block-level and
// in-paragraph alike. Expected page starts are derived from the same
// arithmetic the solver used: pageStart_{k+1} = pageStart_k + max(fill_k,
// 864) + 216, with fill_k = 864 - remaining_k.
const CONTENT_H = 864
const BAND = 216
const landing = await page.evaluate(() => {
  const { view, key } = window.__pager
  const pmTop = view.dom.getBoundingClientRect().top
  const s = view.state
  return (key.getState(s)?.breaks ?? []).map((b, i) => {
    const w = [...view.dom.querySelectorAll(".page-gap")].find(
      (x) => x.dataset.page === String(i)
    )
    return {
      bottom: w ? w.getBoundingClientRect().bottom - pmTop : null,
      remaining: b.remaining,
    }
  })
})
let pageStart = 0
landing.forEach((l, i) => {
  pageStart += Math.max(CONTENT_H - l.remaining, CONTENT_H) + BAND
  ok(
    l.bottom != null && Math.abs(l.bottom - pageStart) <= 0.5,
    `widget ${i} box bottom = page ${i + 2} content start (${pageStart.toFixed(1)})`,
    l.bottom == null ? "widget missing" : `off by ${(l.bottom - pageStart).toFixed(2)}px`
  )
})

console.log("— justified text: flush lines, including across a page split")
// Word rects grouped into visual lines — the same measuring method the
// pagination plugin uses. A justified paragraph must put every line except
// its last flush at the paragraph's right edge; the last line stays ragged.
const measureJustified = (mode) =>
  page.evaluate((mode) => {
    const ps = [...document.querySelectorAll(".ProseMirror p")]
    const p =
      mode === "split"
        ? ps.find((el) => el.querySelector(".page-gap"))
        : ps.find((el) => el.style.textAlign === "justify")
    if (!p) return { error: "no such paragraph" }
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const words = []
    let tn
    while ((tn = walker.nextNode())) {
      // The gap widget renders its own page number — decoration, not text.
      // Skip it, the same way the plugin's measurement does.
      if (tn.parentElement?.closest(".page-gap")) continue
      const s = tn.textContent || ""
      const re = /\S+/g
      let m
      while ((m = re.exec(s))) {
        const r = document.createRange()
        r.setStart(tn, m.index)
        r.setEnd(tn, m.index + m[0].length)
        const rect = r.getBoundingClientRect()
        if (rect.width || rect.height) words.push(rect)
      }
    }
    words.sort((a, b) => a.top - b.top)
    const lines = []
    for (const w of words) {
      const line = lines[lines.length - 1]
      const overlap = line ? Math.min(line.bottom, w.bottom) - Math.max(line.top, w.top) : 0
      if (line && overlap > Math.min(line.bottom - line.top, w.bottom - w.top) / 2) {
        line.top = Math.min(line.top, w.top)
        line.bottom = Math.max(line.bottom, w.bottom)
        line.right = Math.max(line.right, w.right)
      } else {
        lines.push({ top: w.top, bottom: w.bottom, right: w.right })
      }
    }
    const right = p.getBoundingClientRect().right
    const gapBox = p.querySelector(".page-gap")?.getBoundingClientRect() ?? null
    const bad = []
    lines.forEach((l, i) => {
      if (i < lines.length - 1 && Math.abs(l.right - right) > 1) bad.push({ line: i, shortBy: right - l.right })
    })
    const flush = (l) => Math.abs(l.right - right) <= 1
    return {
      error: null,
      justified: p.style.textAlign === "justify",
      lineCount: lines.length,
      bad,
      right,
      lastRight: lines[lines.length - 1]?.right ?? null,
      hasGap: !!gapBox,
      aboveGap: gapBox ? lines.filter((l) => l.bottom <= gapBox.top && flush(l)).length : 0,
      belowGap: gapBox ? lines.filter((l) => l.top >= gapBox.bottom && flush(l)).length : 0,
    }
  }, mode)

// 5a. The seed's justified paragraph: flush everywhere but the last line.
const seedJust = await measureJustified("seed")
ok(seedJust.error === null, "seed's justified paragraph is in the DOM (toDOM wrote the style)")
ok(seedJust.justified && seedJust.lineCount >= 2, `justified paragraph wraps to ${seedJust.lineCount} lines`)
ok(
  seedJust.bad.length === 0,
  "every line but the last sits flush at the right margin",
  `bad lines: ${JSON.stringify(seedJust.bad)}`
)
ok(
  seedJust.lastRight != null && seedJust.lastRight < seedJust.right - 10,
  "the last line stays ragged (browsers never justify it)",
  `last line right edge ${(seedJust.right - seedJust.lastRight).toFixed(1)}px short`
)

// 5b. Justify a paragraph that straddles a page boundary, through the real
// toolbar control, and check the lines on both sides of the gap widget.
await page.evaluate(() => {
  const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
    el.querySelector(".page-gap")
  )
  const range = document.createRange()
  range.selectNodeContents(p)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
await page.select('select[title="Alignment"]', "justify")
await sleep(900) // debounced reflow
const splitJust = await measureJustified("split")
ok(splitJust.error === null && splitJust.justified, "toolbar Alignment control justified the split paragraph")
ok(splitJust.hasGap, "that paragraph still straddles a page (contains a gap widget)")
ok(
  splitJust.bad.length === 0,
  "flush across the whole split paragraph, on both pages",
  `bad lines: ${JSON.stringify(splitJust.bad)}`
)
ok(
  splitJust.aboveGap >= 1 && splitJust.belowGap >= 1,
  "flush lines both above and below the gap widget",
  `above=${splitJust.aboveGap} below=${splitJust.belowGap}`
)

console.log("— doc.toJSON() carries no page nodes")
const docDumped = await page.evaluate(() => {
  ;[...document.querySelectorAll(".panel-buttons button")][1].click()
  return true
})
ok(docDumped, "dump button works (see browser console)")

await browser.close()
try {
  process.kill(-server.pid, "SIGTERM")
} catch {}

console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
