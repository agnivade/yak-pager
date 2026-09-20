Editor Pagination — Design Decisions

---

# 1. Pagination is not part of the CRDT

Page breaks are computed locally and rendered as ProseMirror decorations. They never enter the `Y.Doc`.

**Why?**

It is not technically impossible to put break positions within a CRDT. But then conflict resolution becomes tricky. There is no inherently “correct” global page break. They may vary depending on font size, browser engines, and differences in rendering stacks.

It does mean that the document might look different in different systems, but that only remains within the browser. The exported content anyways is not guaranteed to match with the live pagination state. (See point 2).

**What remains in the CRDT:**

- Explicit page breaks (user pressed ctrl-enter)
- Page metadata - margins, header/footer content etc.

**What is local-only:**

- Computed break positions
- Measured block heights.

**Consequences:**

- **No reflow churn.** Typing on page 1 of a 40-page document generates one character insert, not costly DOM operations all throughout the document.
- **Cursors survive.** Content is never deleted-and-reinserted to move between pages, so Yjs Item IDs stay stable and collaborative cursors keep resolving.

---

# 2. No export parity requirement

No point trying to have a 1-1 parity with docx/odt. It’s the same in Google docs as well. I have tested it and the exported docx/odt varies in where the page breaks are generated.

That also makes sense, because Word and LibreOffice have their own rendering engines which run during *file open time*. It is not metadata that you can embed in the file content itself. 

**Alternatives considered:** Run a wasm build of Libreoffice within the browser. But that’s too costly. There’s only one player in the market - ZetaOffice and that doesn’t even work properly. It’s not worth a path going down.

**What we optimize for instead:** live pagination that is correct, fast, and consistent across *our own* clients — plus a print preview that reflects it accurately.

**Caveat**: there are indeed concepts like `w:br w:type="page"` in docx, `fo:break-before` in odt. But it’s not really a solution. Because the downloaded document will never reflow. Those page breaks will become static. It’s only a solution if the downloaded document is meant to be fully static and never edited, which does not sound like a good solution.

---

# 3. Content never moves between pages

There is no page container to move a paragraph between. The document stays a flat list of blocks. Only break positions change.

**Reflow = recomputing break positions, not moving nodes.**

Given blocks `[H, A, B, C, T, D]` and a break currently before `T`:

```
Solve:   accumulate heights → first overflow marks the break
Render:  Decoration.widget(pos, <page gap>)          ← real DOM, contenteditable=false
         Decoration.node(pos, { margin-top: Npx })   ← attribute write on existing node
```

before:  [H, A, B, C, ←break→ T(table), D]   table had the mark
after:   [H, A, B, ←break→ C, T(table), D]   C's <p> has the mark

When B grows and the break moves earlier, the complete set of DOM operations is:

1. B's `<p>` — text updated (the actual edit)
2. C's `<p>` — `setAttribute` class + style
3. `<table>` — `removeAttribute` class + style
4. Gap widget — `insertBefore` to its new position (keyed, so reused not recreated)

No element created or destroyed. No subtree reparented. The `<table>` keeps its identity, children, scroll position, and any focus inside it.

**The page look is CSS.** A fixed-width white column with a shadow.

---

# Open Questions

## How to split paragraphs

So far, we haven't brought up splitting nodes. In the above design, a paragraph that does not fit on a page is pushed whole to the next page. This creates "ragged bottoms", but keeps the logic simple. However, it is not the right user experience because a user will suddenly notice the whole paragraph shifting to the next page.

But at the same time, we cannot split the paragraph nodes. That would put pagination into the document: it would enter history, so Ctrl+Z would fight the reflow, and every keystroke near a page boundary would rewrite document structure. It also breaks rule 1 (no page nodes in the doc).

One proposal is to keep the paragraph as one document node and place the gap widget *between two words* inside it, so the first lines fill the current page and the rest flows onto the next. Then the question becomes of how to exactly render this gap widget inside a paragraph correctly.

The following are two proposals:

- **`display: inline-block; width: 100%`** — simple, but wrong by a few pixels. Every text line behaves as if it held an invisible zero-width character as tall as the paragraph's line-height, and an empty inline-block aligns its bottom edge to the text baseline. So the line box becomes widget height plus that extra leading, and the words after the widget land too low. The error depends on font metrics (it changes with font-size marks) and it accumulates into every break inside a paragraph.
- **`float: left; clear: both; width: 100%`** — floats are ignored by baseline layout, and a cleared line must start below the float's bottom edge. No baseline math, no extra leading: the inserted space is the widget's height, exactly like the block-level case. The price is float quirks (interaction with `text-align: justify`, and the paragraph box growing correctly around a cleared float).

Needs to be verified practically.

---
