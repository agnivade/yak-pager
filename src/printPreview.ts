/**
 * PRINT PREVIEW SPIKE — two ways to make what prints match what the live view
 * paginated. Both read the solver's break list out of the pagination plugin
 * (the same PaginationState.breaks the gap widgets render from) and cut the
 * document at exactly those positions, so neither one lets the print engine
 * decide where a page ends.
 *
 * Approach B — one continuous flow, page boxes from the print engine. The
 * whole document is one column; the first content of every page carries
 * `break-before: page`. Sheet size, margins and the page number come from
 * @page. The print engine owns the page frame; we only mark the seams.
 *
 * Approach C — real page containers in the DOM. One <section class="sheet">
 * per solver page, filled by slicing the document at the break positions.
 * @page is full bleed; margins and page numbers are drawn by us, so the
 * on-screen preview and the printout are the same rendering.
 *
 * A paragraph whose break is inline becomes two real <p> elements, one per
 * page, in both approaches. That is allowed here because the print document
 * is a throwaway rendering built from the doc model: it never touches editor
 * state, history, or the Y.Doc, exactly like the decorations it mirrors.
 *
 * Geometry is the live view's geometry (src/layout.ts): 816x1056 sheets, 96px
 * margins, a 624px writable column. The content CSS is copied from the
 * editor's styles.css; any drift there re-wraps lines and breaks parity.
 */
import { DOMSerializer } from "prosemirror-model"
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { schema } from "./schema"
import { paginationKey } from "./paginationPlugin"
import { PX_PER_IN, SHEET_W, SHEET_H, MARGIN } from "./layout"

/** Paper size as a CSS @page value, derived from the live geometry. */
const PAGE_SIZE = `${SHEET_W / PX_PER_IN}in ${SHEET_H / PX_PER_IN}in`

/**
 * The typography of the writable column, copied from `#paper .ProseMirror`
 * in styles.css. Emitted per approach with a scope selector, because B wraps
 * content in one .doc column while C scopes it inside every .sheet.
 */
function typography(scope: string): string {
  return `
/* Content styles copied verbatim from the live editor. Any drift re-wraps
   lines and breaks screen/print parity. */
${scope} {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 16px;
  line-height: 1.5;
  color: #1f2328;
  word-wrap: break-word;
  white-space: pre-wrap;
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
}
${scope} > * { margin: 0; }
${scope} p { padding-bottom: 10px; }
${scope} h1 { font-size: 28px; line-height: 1.25; padding: 18px 0 10px; font-weight: 700; }
${scope} h2 { font-size: 22px; line-height: 1.3; padding: 16px 0 8px; font-weight: 700; }
${scope} h3 { font-size: 18px; line-height: 1.35; padding: 12px 0 8px; font-weight: 600; }
${scope} hr { border: none; border-top: 2px solid #c3c9d2; padding: 14px 0; }
/* The explicit-break marker keeps its 17px box (1px border + 6px + 10px
   padding) so page geometry is unchanged, but prints nothing. */
${scope} [data-page-break] { visibility: hidden; border-top: 1px solid transparent; padding: 6px 0 10px; }
`
}

function printCSS(approach: "B" | "C"): string {
  if (approach === "B") {
    return `
/* Page boxes come entirely from the print engine: sheet size and the 96px
   margins are @page, and the page number is a margin box (Chrome 131+; on
   older browsers the numbers are simply absent). The writable column is
   816 - 2x96 = 624px — the same 624px the live editor writes in. */
@page {
  size: ${PAGE_SIZE};
  margin: ${MARGIN}px;
  @bottom-center {
    content: counter(page);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 11px;
    color: #6b7280;
  }
}
html, body { margin: 0; padding: 0; }
${typography(".doc")}
/* The one instruction the print engine gets: a forced break before the first
   content of every page the solver carved. */
.new-page { break-before: page; }
`
  }
  return `
/* The page boxes exist in the DOM: one section.sheet per solver page, sized
   like the sheets the live view paints. @page is full bleed — margins and
   page numbers are drawn by us, so preview and print share one rendering. */
@page { size: ${PAGE_SIZE}; margin: 0; }
html, body { margin: 0; padding: 0; }
.sheet {
  width: ${SHEET_W}px;
  height: ${SHEET_H}px;
  box-sizing: border-box;
  padding: ${MARGIN}px;
  position: relative;
  page-break-after: always;
}
/* A break-after on the last sheet would add a trailing blank page. */
.sheet:last-child { page-break-after: auto; }
${typography(".sheet")}
.page-num {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: ${MARGIN}px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  color: #6b7280;
}
/* Preview-only dressing: the gray desk and sheet shadows, never printed. */
@media screen {
  body { background: #d8dde5; padding: 24px 0; }
  .sheet { margin: 0 auto 24px; box-shadow: 0 2px 8px rgba(31, 35, 40, 0.25); }
}
`
}

/**
 * Slice the document into pages at the solver's break positions. Returns one
 * array of block elements per page — the same pages the live view renders:
 * a break at a block's start begins a new page for that block, and a break
 * inside a paragraph cuts it into real halves, one per page.
 *
 * Elements are rendered from the doc model with the schema's own toDOM, so
 * marks, alignment attributes and hard breaks all serialize exactly as the
 * live view renders them.
 */
function slicePages(view: EditorView): HTMLElement[][] {
  const breaks = [...(paginationKey.getState(view.state)?.breaks ?? [])].sort((a, b) => a.pos - b.pos)
  const breakPositions = new Set(breaks.map((b) => b.pos))
  const serializer = DOMSerializer.fromSchema(schema)
  const pages: HTMLElement[][] = [[]]
  let cur = 0
  const newPage = () => {
    cur++
    pages.push([])
  }

  view.state.doc.forEach((node: PMNode, offset: number) => {
    // A break at this block's start: the block opens the next page.
    if (breakPositions.has(offset)) newPage()

    if (node.type.name !== "paragraph") {
      pages[cur].push(serializer.serializeNode(node) as HTMLElement)
      return
    }

    // Inline breaks inside this paragraph: cut positions relative to the
    // paragraph's content start. A block break at `offset` was handled above.
    const contentStart = offset + 1
    const size = node.content.size
    const cuts = breaks.map((b) => b.pos - contentStart).filter((cut) => cut > 0 && cut < size)

    if (cuts.length === 0) {
      pages[cur].push(serializer.serializeNode(node) as HTMLElement)
      return
    }

    let from = 0
    const stops = [...cuts, size]
    stops.forEach((stop, i) => {
      if (i > 0) newPage()
      const half = node.copy(node.content.cut(from, stop))
      const el = serializer.serializeNode(half) as HTMLElement
      if (node.attrs.align === "justify" && i < stops.length - 1) {
        // On screen, the line before a gap spacer is an interior line, so
        // justify keeps it flush. In the print document the same line is the
        // LAST line of a real paragraph, which browsers leave ragged unless
        // told otherwise. Force it back — one rule per seam.
        el.style.setProperty("text-align-last", "justify")
      }
      pages[cur].push(el)
      from = stop
    })
  })
  return pages
}

/**
 * Assemble the print document. Blocks are concatenated with NO whitespace
 * between them: the content column is `white-space: pre-wrap` (copied from
 * the live editor, where ProseMirror emits no inter-block whitespace), so a
 * stray newline here would render as a phantom empty line.
 */
function buildPrintHTML(view: EditorView, approach: "B" | "C"): string {
  const pages = slicePages(view)
  const body =
    approach === "B"
      ? pages
          .map((group, i) => {
            if (i > 0 && group[0]) group[0].classList.add("new-page")
            return group.map((el) => el.outerHTML).join("")
          })
          .join("")
      : pages
          .map((group, i) => {
            const sec = document.createElement("section")
            sec.className = "sheet"
            sec.append(...group)
            const num = document.createElement("div")
            num.className = "page-num"
            num.textContent = String(i + 1)
            sec.append(num)
            return sec.outerHTML
          })
          .join("")
  const wrapped = approach === "B" ? `<main class="doc">${body}</main>` : body
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>yak-pager print preview (${approach})</title>
<style>${printCSS(approach)}</style>
</head>
<body>${wrapped}</body>
</html>
`
}

/* ------------------------------------------------------------------ */
/* Approach B — hidden iframe, straight to the browser print dialog     */
/* ------------------------------------------------------------------ */

let printFrameB: HTMLIFrameElement | null = null

function printB(view: EditorView): void {
  printFrameB?.remove()
  const frame = document.createElement("iframe")
  printFrameB = frame
  frame.id = "print-frame-b"
  // Off-screen but rendered: a display:none iframe is not laid out, and some
  // browsers refuse to print it.
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${SHEET_W}px;height:${SHEET_H}px;border:0;`
  frame.srcdoc = buildPrintHTML(view, "B")
  frame.addEventListener("load", () => {
    const w = frame.contentWindow
    if (!w) return
    w.addEventListener("afterprint", () => {
      frame.remove()
      if (printFrameB === frame) printFrameB = null
    })
    // One paint before handing the document to the print engine.
    w.setTimeout(() => {
      w.focus()
      w.print()
    }, 50)
  })
  document.body.append(frame)
}

/* ------------------------------------------------------------------ */
/* Approach C — in-app preview modal; the same iframe prints            */
/* ------------------------------------------------------------------ */

let modal: HTMLDivElement | null = null
let refit: (() => void) | null = null

function closeModal(): void {
  modal?.remove()
  modal = null
  refit = null
}

function previewC(view: EditorView): void {
  closeModal()

  const m = document.createElement("div")
  m.id = "print-modal"
  m.classList.add("pm-loading") // visibility:hidden — keeps layout, so the iframe measures

  const head = document.createElement("div")
  head.className = "pm-head"
  const title = document.createElement("span")
  title.textContent = "Print preview — approach C: one <section> per solver page"
  const actions = document.createElement("div")
  actions.className = "pm-actions"
  const printBtn = document.createElement("button")
  printBtn.className = "pm-print"
  printBtn.textContent = "Print…"
  const closeBtn = document.createElement("button")
  closeBtn.textContent = "Close"
  actions.append(printBtn, closeBtn)
  head.append(title, actions)

  const body = document.createElement("div")
  body.className = "pm-body"
  const zoom = document.createElement("div")
  zoom.className = "pm-zoom"
  const frame = document.createElement("iframe")
  frame.className = "pm-frame"
  frame.style.width = `${SHEET_W}px`
  frame.srcdoc = buildPrintHTML(view, "C")
  zoom.append(frame)
  body.append(zoom)
  m.append(head, body)

  const fit = () => {
    const avail = body.clientWidth - 48
    const scale = Math.min(1, avail / SHEET_W)
    zoom.style.transform = `scale(${scale})`
    zoom.style.width = `${SHEET_W * scale}px`
    zoom.style.height = `${frame.offsetHeight * scale}px`
  }
  refit = fit

  frame.addEventListener("load", () => {
    frame.style.height = `${frame.contentDocument?.documentElement.scrollHeight ?? 0}px`
    fit()
    m.classList.remove("pm-loading")
  })

  printBtn.onclick = () => {
    const w = frame.contentWindow
    if (!w) return
    // Undo the preview scaling in case the print run accounts for parent
    // transforms; the print dialog covers the screen meanwhile, and
    // afterprint puts the preview back exactly as it was.
    zoom.style.transform = "none"
    w.addEventListener("afterprint", fit, { once: true })
    w.focus()
    w.print()
  }
  closeBtn.onclick = closeModal

  document.body.append(m)
  modal = m
}

/* ------------------------------------------------------------------ */
/* Toolbar wiring                                                       */
/* ------------------------------------------------------------------ */

export function buildPrintPreviewButtons(view: EditorView, mount: HTMLElement): void {
  const b = document.createElement("button")
  b.textContent = "Preview B"
  b.title =
    "Approach B: one continuous flow with break-before: page at the solver's break positions; page boxes, margins and numbers come from @page. Opens the browser print dialog."
  b.onclick = () => printB(view)

  const c = document.createElement("button")
  c.textContent = "Preview C"
  c.title =
    "Approach C: real page containers (<section> per solver page) filled by slicing the document; margins and numbers are DOM. Opens an in-app preview whose own document prints."
  c.onclick = () => previewC(view)

  mount.append(b, c)

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal != null) closeModal()
  })
  window.addEventListener("resize", () => {
    if (modal != null) refit?.()
  })
}
