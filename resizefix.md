# resizefix.md — Column resize + full-width layout fixes for View.aspx

**Audience:** Claude (Opus 4.8) working on the *production* copy of the View page
(`View.aspx` and its CSS/JS). The production files differ from the reference copy, so
do **not** copy files — apply the changes described below by locating each site in the
production code.
**Origin:** Implemented and verified on the reference copy (`view.html` / `view.js` /
`view.css`) on 2026-07-17.

**IMPORTANT — how to use this document:**
- Do **NOT** use line numbers. Locate every change by **CSS selector**, **function
  name**, or the **code patterns** quoted below. If a name differs on the server, each
  change also describes how to find the code by behavior.
- Apply the changes **in order**. Change 2 builds on Change 1; Changes 3 and 4 build
  on both.
- These are surgical changes. Preserve all surrounding behavior; do not refactor,
  rename, or "improve" adjacent code while applying them.
- Reference names used throughout (adapt to the server's actual names):
  - `#spreadsheet` — the main grid `<table>`
  - `#spreadsheet-container` — its scrollable wrapper (`overflow: auto`)
  - `#header-row` — the `<tr>` inside `<thead>` holding the column headers
  - `#spreadsheet-body` — the `<tbody>`
  - `th.col-header` — one header cell per data column, carries `data-col-index`
  - `td.cell` — one body cell per data column, carries `data-row` / `data-col`
  - `td.row-number` / `.row-number-header` — the fixed 55px row-number gutter
  - `renderHeaders()` / `renderBody()` — the header/body render functions
  - `columns` — the column model array; `columns[i].width` is the persisted px width

---

## What was wrong / what was built (summary of all four changes)

1. **Bug:** A column could not be dragged *narrower* than its longest non-wrapping
   cell text (a very long Task Name description blocked the resize handle from moving
   left). Root cause: the table had `table-layout: fixed` **with `width: max-content`**.
   Fixed table layout requires a *definite* width; an intrinsic keyword like
   `max-content` makes the browser silently fall back to the **auto** layout
   algorithm, where non-wrapping cell content dictates a hard minimum column width.
2. **Feature:** When the columns total less than the window width, the grid should
   still fill the container edge to edge (no dead white strip on the right).
3. **Feature (final chosen mode):** "Pixel-faithful" columns — leftover horizontal
   space is absorbed by an invisible **filler column** appended after the last real
   column, so every real column keeps the exact pixel width the user dragged it to
   (instead of all columns being proportionally inflated). Implemented behind a
   single boolean flag `FILLER_COLUMN` so it can be reverted by flipping the flag.
4. **Feature:** On load, if the persisted column widths don't fill the container, the
   **Task Name column (column 0)** is stretched — render-only, never persisted — by
   exactly the deficit, so a freshly loaded project has no white strip either.

---

## Prerequisite — verify before changing anything

The fixes assume the production CSS already clips cell text. Confirm these rules
exist (they did on the reference copy); add them if missing:

```css
td.cell {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
```

Also confirm the grid table declares `table-layout: fixed`, the header cells get an
explicit inline pixel `width` from JS when headers render, and the row-number gutter
is a fixed width (55px on the reference copy — if the server's gutter width differs,
substitute that value everywhere `55` appears below).

---

## Change 1 — Make fixed table layout actually apply (CSS)

### Where
The CSS rule for the main grid table (reference selector `#spreadsheet`). Find it by
looking for `table-layout: fixed` together with `width: max-content` (the server may
have `width: auto` or no width instead — the fix is the same).

### What to change
Replace the table's width with a definite `0` and add `min-width: 100%`:

```css
#spreadsheet {
    border-collapse: collapse;
    table-layout: fixed;
    /* A definite width is required for fixed layout to actually apply;
       the table still grows to the sum of the header column widths, so
       long nowrap cell text is clipped instead of stretching the column.
       min-width keeps it filling the container when columns total less. */
    width: 0;
    min-width: 100%;
}
```

### Why `width: 0` works
Under `table-layout: fixed`, the used table width is **the greater of** the `width`
property and the sum of the column widths. So the table still grows to fit all
columns (horizontal scrolling in the container keeps working), but column widths now
come *only* from the first-row `<th>` widths — cell content can no longer push a
column wider or block it from shrinking.

### Verify
Load a project with a cell whose text is much longer than its column. Drag that
column's resize handle to the left: it must now shrink freely (down to the JS-enforced
minimum, 10px on the reference copy), clipping the long text with an ellipsis. Row
heights must not change.

---

## Change 2 — Filler column flag + rendering (JS)

An invisible filler column appended after the last real column. Because it is the
only column with **no width set**, the fixed-layout algorithm hands it *all* leftover
space, and the real columns keep their exact pixel widths.

### 2a. The flag

Add near the top of the rendering section (just before the top-level render function,
`renderAll()` on the reference copy):

```js
// PIXEL-FAITHFUL COLUMNS: when true, an invisible filler column absorbs
// any leftover space to the right of the last column, so every real
// column keeps the exact pixel width it was dragged to. Set to false to
// go back to stretch mode, where leftover space is distributed across
// all columns proportionally instead.
var FILLER_COLUMN = true;
```

It must be in scope for both the header and body render functions.

### 2b. Header render — cleanup selector and filler `<th>`

Find the header render function (`renderHeaders()`): it selects `#header-row`,
removes the existing `th.col-header` elements, then loops over `columns` building one
`<th class="col-header">` per column with an inline pixel width.

Two edits:

1. The removal at the top must also remove the filler so re-renders don't stack it:
   ```js
   $row.find('th.col-header, th.col-filler').remove();
   ```
2. **After** the column loop finishes (i.e. after the last real `<th>` is appended),
   append the filler:
   ```js
   // Filler column: no width set, so table-layout:fixed gives it all the
   // leftover space and the real columns keep their exact pixel widths
   if (FILLER_COLUMN) $row.append('<th class="col-filler">');
   ```

The filler `<th>` deliberately has **no** `data-col-index`, no `col-header` class, no
resize handle, and no width. On the reference copy every other piece of header JS
(resize lock, width persistence, drag-reorder) selects `th.col-header` specifically,
so the filler is invisible to them — **verify the same is true on the server** before
proceeding (search the JS for iterations over header `<th>` elements; any loop using a
bare `th` selector or positional `children()` indexing must be updated to skip the
filler).

### 2c. Body render — filler `<td>` per row

Find the body render function (`renderBody()`): it loops `for (var r = 0; ...)`
building a `<tr data-row=...>`, appends the row-number `<td>`, then an inner loop
appends one `<td class="cell">` per column.

After the inner column loop, immediately before the `<tr>` is appended to the body:

```js
if (FILLER_COLUMN) $tr.append('<td class="filler-cell">');
```

The reference copy also appends 5 borderless "padding rows" after the data rows for
breathing room (look for a `padding-row` class). If the server has these, give each
one a filler too:

```js
if (FILLER_COLUMN) $padRow.append('<td class="filler-cell">&nbsp;</td>');
```

The filler `<td>` deliberately has **no** `cell` class and no `data-row`/`data-col`
attributes, so selection, editing, keyboard navigation, copy/paste, and search all
ignore it. **Verify the server's cell interaction handlers bind to `td.cell` (or
equivalent) and not to bare `td`.**

If the server has a partial-row re-render path (e.g. `renderSingleCell`), confirm it
targets cells by `data-row`/`data-col` and therefore never touches the filler — true
on the reference copy, no change needed there.

### 2d. Filler CSS

Add near the other `td.cell` rules:

```css
/* Pixel-faithful filler column (see FILLER_COLUMN flag in view.js).
   The header filler inherits the blue thead styling so the header bar
   runs edge to edge; body fillers stay plain white and ignore row
   hover/selection highlights so the area reads as "outside the grid". */
td.filler-cell {
    background: #fff !important;
    border: none !important;
    cursor: default;
}
```

The `!important`s are load-bearing: the reference copy (and likely the server) has
row-hover and row-selected rules of the form `#spreadsheet tbody tr:hover td { ... }`
that would otherwise paint the filler. No rule is needed for `th.col-filler` — it
inherits the normal `thead th` styling, which is what makes the header bar run to the
right edge of the window.

### Verify
Refresh with columns totalling less than the window: the header bar runs edge to
edge; the area right of the last column is plain white with no borders and no hover
highlight. Shrink a column: only the white filler grows — no other column moves.
Widen columns past the window: the filler collapses to zero and horizontal scrolling
behaves exactly as before. Flip `FILLER_COLUMN` to `false` and refresh: leftover
space is instead distributed proportionally across all columns (stretch mode) — this
is the documented revert path, the CSS stays in place and is inert.

---

## Change 3 — Task Name absorbs the leftover space on load (JS)

Without this, a freshly loaded project whose *persisted* widths total less than the
window shows the filler's white strip (by design, but the users didn't want it on
initial load).

### Where
Inside the header render function, **after** the persisted-widths check /
default-width computation, and **before** the column loop. On the reference copy the
function starts by computing `hasSavedWidths` and a `computedColWidth` fallback
(default 160, or container width divided by visible columns for new projects) — the
new block goes right after that.

### What to add

```js
// In filler mode, if the saved widths don't fill the container, give
// the leftover space to the Task Name column on render. Render-only:
// columns[0].width is not modified, so nothing is persisted and the
// amount re-adapts to the window size on every reload.
var col0Extra = 0;
if (FILLER_COLUMN && !columns[0].hidden) {
    var fillerContainerWidth = $('#spreadsheet-container')[0] ? $('#spreadsheet-container')[0].clientWidth : 0;
    if (fillerContainerWidth > 0) {
        var totalWidth = 55; // row-number column
        $.each(columns, function (i, col) {
            if (!col.hidden) totalWidth += (col.width || computedColWidth);
        });
        if (totalWidth < fillerContainerWidth) col0Extra = fillerContainerWidth - totalWidth;
    }
}
```

Then, inside the column loop, find the line that resolves the width applied to each
`<th>` — on the reference copy:

```js
var colWidth = col.width || computedColWidth;
```

and change it to:

```js
var colWidth = (col.width || computedColWidth) + (i === 0 ? col0Extra : 0);
```

Adapt `55` to the server's row-number gutter width and `computedColWidth` to the
server's fallback-width variable. `columns[0]` is the Task Name column; if the server
can hide column 0, the guard `!columns[0].hidden` skips the stretch in that case
(the filler still covers the gap, which is acceptable).

### Intentional behaviors — do not "fix" these
- The stretch is **render-only**. It re-computes from the live container width on
  every render, so it adapts to different window sizes and never widens Task Name
  when the columns already overflow.
- The reference copy's resize **mouseup** handler persists the *rendered* width of
  every column into `columns[i].width` and saves. Consequently, the first manual
  column resize after load makes the stretched Task Name width permanent. This is
  deliberate ("what you see is what you save") — leave it.
- Shrinking columns mid-session shows the filler strip until the next full render;
  headers are intentionally **not** re-rendered on every resize or window resize,
  because live re-stretching would fight the user while they are deliberately making
  columns smaller.

### Verify
1. Resize columns so they total well under the window width; trigger a save; reload.
   Task Name must be wider than its saved width by exactly the deficit and the grid
   must end flush at the right edge (no white strip).
2. Reload in a much narrower window where columns overflow: no stretch, normal
   horizontal scrollbar.
3. After the stretched load, drag Task Name narrower: it must shrink freely (the
   stretch is not sticky during interaction), and the filler covers the freed space.

---

## Full verification checklist (run after all changes)

1. Long-text cell: column shrinks past the text; text clips with ellipsis; no row
   height change; no text wrapping.
2. Column grows normally when dragged right; widths persist across reload after a
   manual resize.
3. Columns < window: header bar edge to edge, white inert filler on the right,
   pixel-exact column widths.
4. Columns > window: horizontal scroll, filler collapsed, unchanged behavior.
5. Fresh load with narrow saved widths: Task Name absorbs the deficit, no strip.
6. Cell selection, range selection, editing, copy/paste, search highlight, frozen
   columns, column drag-reorder, and column hide/unhide all behave exactly as before
   (the filler has none of the classes/attributes those features select on).
7. Revert check: `FILLER_COLUMN = false` + refresh → stretch mode, nothing broken.
