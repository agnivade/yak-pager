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

When B grows and the break moves earlier, the complete set of DOM operations is:

1. B's `<p>` — text updated (the actual edit)
2. C's `<p>` — `setAttribute` class + style
3. `<table>` — `removeAttribute` class + style
4. Gap widget — `insertBefore` to its new position (keyed, so reused not recreated)

No element created or destroyed. No subtree reparented. The `<table>` keeps its identity, children, scroll position, and any focus inside it.

**The page look is CSS.** A fixed-width white column with a shadow.

---
