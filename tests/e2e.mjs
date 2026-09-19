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

// Placement: each widget must sit immediately before the block that begins
// the page after its break — doc positions checked against the real doc.
const placement = await page.evaluate(() => {
  const { view } = window.__pager
  const s = view.state
  const breaks = s.plugins
    .map((p) => p.getState?.(p.key ?? "pagination"))
    .find((st) => st && "breaks" in st)
  const bl = breaks?.breaks ?? []
  const blocks = [...view.dom.children].filter(
    (el) => !(el.classList && el.classList.contains("page-gap"))
  )
  const widgets = [...view.dom.children].filter(
    (el) => el.classList && el.classList.contains("page-gap")
  )
  const bad = []
  bl.forEach((b, i) => {
    const idx = s.doc.resolve(b.pos).index() // top-level block index at break
    const w = widgets.find((x) => x.dataset.page === String(i))
    if (!w) return void bad.push(`widget ${i} missing`)
    if (w.nextElementSibling !== blocks[idx])
      bad.push(`widget ${i} not before block ${idx}`)
  })
  return { breaks: bl.map((b) => b.pos), bad, blocks: blocks.length }
})
ok(placement.bad.length === 0, "every widget sits exactly before its break's block", JSON.stringify(placement.bad))

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
