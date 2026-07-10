# fixshift.md — Fix instructions for design.html list shift / freeze on add-subtask

**Audience:** Claude (Opus 4.8) working on a *modified* copy of `design.js` on the server.
**Origin:** These fixes were implemented and verified on the reference copy of the project
on 2026-07-10 against a large Execution project (~730 nodes under one top-level task,
~300 rendered subtask rows). Measurements below are from that machine.

**IMPORTANT — how to use this document:**
- Do **NOT** use line numbers. The server's `design.js` differs from the reference copy
  (parts removed, parts added). Locate every change by **function name**, **jQuery
  selector**, or the **code patterns** quoted below.
- Function or handler names may have been renamed on the server. Each fix therefore also
  describes *how to find the code by behavior* if the name doesn't match.
- Preserve all surrounding behavior exactly. These are surgical fixes; do not refactor,
  rename, or "improve" adjacent code while applying them.
- After each fix, run the verification snippet at the bottom.

---

## The bug being fixed (symptom)

In `design.html`, with a top-level task selected that has a **long** subtask list
(hundreds of rows): clicking the **“+” button next to a subtask** ("Add sub-subtask"),
or the **"+ Add Subtask"** toolbar button:

1. The UI freezes for 1–2 seconds.
2. The new row appears and **the whole list visibly shifts**.
3. About a second later the list **shifts back**.

With short subtask lists the problem is invisible. Users reported it as "the whole list
or screen moves because of this new row being created and then 1 second it shifts back."

## Root causes (three, all confirmed by measurement)

1. **Delayed auto-scrolling focus.** Both add handlers end with
   `setTimeout(function () { ... $input.focus(); }, 50)`. A plain `.focus()` scrolls the
   focused element into view, yanking the scroll panel. Because it runs on a timer
   *after* the heavy re-render, the user first sees the row-insertion shift, then — up
   to a second later — the focus-scroll shift. One handler also has a fallback
   `$('#subtask-body input[data-field="name"]').last().focus()` that can jump the view
   to the very bottom of the list.
2. **Layout thrash in the post-render row-height sync.** `syncTreeCellHeights()` (runs
   via `setTimeout(..., 0)` after every subtask-table render, and again via a
   MutationObserver) loops over all rows alternating a layout **read**
   (`rows[i].offsetHeight`) with a layout **write** (`cell.style.height = h`). Each
   write invalidates layout, so every read forces a synchronous reflow: **one forced
   reflow per row** (~300 on a large list — seconds of main-thread stall wedged exactly
   between the two visible shifts).
3. **O(n²) work and per-row DOM appends in the subtask table render.**
   `renderSubtaskTable()` computes tree connectors with a helper (`hasMoreAtLevel`)
   that forward-scans all rows *per row per depth level*, and appends each built `<tr>`
   directly into the live `#subtask-body` one at a time.

Measured on the reference machine (300-row list): add-click handler **1.9 s** blocked,
then a 57 px scroll jerk from the delayed focus. After the fixes: **zero scroll
movement** (verified — no scroll events fire at all during an add) and the post-render
reflow storm is gone.

---

## Fix 1 — Focus without the scroll jump (both add handlers)

### Where to find it

Two click handlers, located by these selectors:

- `$('#btn-add-subtask').on('click', ...)` — the "+ Add Subtask" toolbar button.
- `$(document).on('click', '[data-add-child]', ...)` — the per-row "+" (Add
  sub-subtask) button.

If the selectors differ on the server, find the handlers by behavior: they create a
pending task object (look for `_pendingAdd = true`), push it into a `subtasks` array,
call the full detail re-render (`renderDetail()` or equivalent), and end with a
`setTimeout(..., 50)` that calls `.focus()` on the new row's name input.

### What to change

In **each** handler, replace the entire trailing `setTimeout(function () { ... }, 50);`
block with an immediate, non-scrolling focus. The new task object variable is `sub` in
the toolbar handler and `child` in the per-row handler — adapt the variable name to
whatever the server code uses:

```javascript
// Focus the new row without the delayed auto-scroll jump: focus() by default
// scrolls the focused element into view (yanking the whole panel), and doing
// it on a 50ms timer made the list visibly shift and then shift back.
// preventScroll stops the yank; block:'nearest' scrolls zero pixels when the
// row is already visible and the minimal amount when it is not.
var newInput = document.querySelector('#subtask-body input[data-field="name"][data-id="' + child.id + '"]');
if (newInput) {
    try { newInput.focus({ preventScroll: true }); } catch (e) { newInput.focus(); }
    if (newInput.scrollIntoView) newInput.scrollIntoView({ block: 'nearest' });
}
```

Rules:
- Run this **immediately after** the `renderDetail()` call (same synchronous block, no
  timer). The input exists in the DOM by then.
- **Delete** any fallback like `$('#subtask-body input[data-field="name"]').last().focus();`
  — it jumps the viewport to the bottom of the list when the ID lookup fails. If the
  input isn't found, do nothing.
- Do not touch anything else in the handlers (the `_pendingAdd` bookkeeping, the
  `!hadChildren` branch that clears/patches parent fields, and the `recompute*()` calls
  must stay exactly as they are).

---

## Fix 2 — Kill the post-render reflow storm in `syncTreeCellHeights()`

### Where to find it

Function named `syncTreeCellHeights` (or similar). Find it by behavior: it is scheduled
with `setTimeout(syncTreeCellHeights, 0)` at the end of the subtask-table render, and
re-scheduled by a MutationObserver on `#subtask-body`. It clears `style.height` on all
`.tree-cell` elements, forces one reflow (`void document.body.offsetHeight;`), then
loops over `#subtask-table tbody tr` rows.

### What to change

The final loop interleaves `offsetHeight` reads with `style.height` writes. Split it
into **two passes: read everything first, then write everything.**

Replace this pattern:

```javascript
// BEFORE (one forced synchronous reflow per row — the interleaved write
// invalidates layout for the next read):
var rows = document.querySelectorAll('#subtask-table tbody tr');
for (i = 0; i < rows.length; i++) {
    var h = rows[i].offsetHeight + 'px';
    var cell = rows[i].querySelector('.tree-cell');
    if (cell) cell.style.height = h;
}
```

with:

```javascript
// AFTER (batched: all reads, then all writes — a single reflow total):
var rows = document.querySelectorAll('#subtask-table tbody tr');
var heights = new Array(rows.length);
for (i = 0; i < rows.length; i++) heights[i] = rows[i].offsetHeight + 'px';
for (i = 0; i < rows.length; i++) {
    var cell = rows[i].querySelector('.tree-cell');
    if (cell) cell.style.height = heights[i];
}
```

Keep steps 1 and 2 of the function (clearing heights, the single `void
document.body.offsetHeight;` recalc) unchanged — only batch the read/write loop.

---

## Fix 3 — `renderSubtaskTable()`: O(n) connectors + single DOM append

### Where to find it

Function named `renderSubtaskTable` (or the function that empties `#subtask-body`,
flattens the selected task's subtasks into a row list, computes tree-connector types
(`'branch' / 'last' / 'vline' / 'spacer'`), and builds one `<tr>` per row).

### Change 3a — replace the quadratic connector scan

Find the nested helper `hasMoreAtLevel(rowIdx, level)` (forward-scans the flattened row
list) and the loop that calls it for every row × every depth level. Replace the helper
**and** that loop with a single backward pass (identical output, O(n·depth)):

```javascript
// Build connector info for continuous tree lines.
// Single backward pass: nearestDepth[L] holds the depth of the nearest
// following row whose depth <= L (or -1), replacing the per-row forward
// scans of the old hasMoreAtLevel (O(n^2) on large lists) with O(1) lookups.
var rowConnectors = new Array(allRows.length);
var maxDepth = 0;
for (var mi = 0; mi < allRows.length; mi++) {
    if (allRows[mi].depth > maxDepth) maxDepth = allRows[mi].depth;
}
var nearestDepth = new Array(maxDepth + 2);
for (var ndi = 0; ndi <= maxDepth + 1; ndi++) nearestDepth[ndi] = -1;
for (var ri = allRows.length - 1; ri >= 0; ri--) {
    var rd = allRows[ri].depth;
    var rConnectors = [];
    for (var L = 0; L <= rd; L++) {
        var hasMore = nearestDepth[L] === L;
        rConnectors.push(L === rd ? (hasMore ? 'branch' : 'last') : (hasMore ? 'vline' : 'spacer'));
    }
    rowConnectors[ri] = rConnectors;
    for (var L2 = rd; L2 <= maxDepth + 1; L2++) nearestDepth[L2] = rd;
}
```

Adapt the variable names (`allRows`, `.depth`, `rowConnectors`) to whatever the server's
version uses. **Equivalence rule to preserve:** for each row and level L, the old
`hasMoreAtLevel(rowIdx, L)` answered "scanning forward, is the first row with
`depth <= L` exactly at depth L?" — the backward pass answers the same question with
`nearestDepth[L] === L`.

### Change 3b — build rows into a detached fragment, append once

In the same function, the per-row loop ends with each `<tr>` being appended directly to
the live table body (`$body.append($tr);`). Change it to build into a detached
`DocumentFragment` and append once after the loop:

```javascript
// Before the row loop:
var $frag = $(document.createDocumentFragment());

// Inside the loop, replace  $body.append($tr);  with:
$frag.append($tr);

// Immediately after the loop closes:
$body.append($frag);
```

This keeps all per-row selector work (`.find()`, etc.) off the live document and lets
the browser lay the table out once instead of once per row. Safe as long as nothing
inside the row loop queries the *live* document for previously appended rows (verified
true in the reference copy; check quickly on the server copy — look for `$('#...')`
document-level selectors inside the loop; per-row `$tr.find(...)`-style calls are fine).

---

## What NOT to change (tempting but wrong)

- Do **not** remove or reorder the `recomputePercentComplete/Status/WorkingDays/Cost`
  calls in the add handlers — parent rollups depend on them, and the blur/commit path
  does not recompute on its own.
- Do **not** replace `renderDetail()` in the add handlers with a surgical single-row
  DOM insert. The new row changes sibling connectors, reorder arrows, and (for a first
  child) the parent row's disabled states — a full re-render keeps all of that correct.
- Do **not** change the pending-row blur handler semantics (named → `addSubtask` patch;
  unnamed → row removed). Only the focus/scroll behavior and render performance are in
  scope.

## Known residual (accepted for now)

After these fixes the add-click is **visually stable** (zero scroll events measured) but
the synchronous re-render still takes ~1.3 s on a 300-row list. The remaining cost is
jQuery element construction (~40 elements × 300 rows per render) in `renderSubtaskTable`.
The proper fix is rebuilding that function's row construction with HTML strings or
row-recycling — a larger, riskier change that was deliberately **not** done. Treat it as
a separate future item.

---

## Verification (run in the browser DevTools console on design.html)

Open a project, select a top-level task with a long subtask list, scroll mid-list, then:

```javascript
// 1) Instrument the scroll panel — the buggy behavior fires scroll events here.
var panel = document.getElementById('detail-panel');   // the scrollable detail pane
window.__scrollLog = [];
panel.addEventListener('scroll', function () {
    window.__scrollLog.push(Math.round(panel.scrollTop));
});

// 2) Click a "+" (Add sub-subtask) button on a row mid-list, or run:
var btn = document.querySelector('[data-add-child]');
var t0 = performance.now();
btn.click();
console.log('handler ms:', Math.round(performance.now() - t0));

// 3) After the render settles, check:
console.log('scroll events fired:', window.__scrollLog.length);   // MUST be 0
console.log('new row focused:', document.activeElement &&
    document.activeElement.getAttribute('data-field') === 'name'); // MUST be true

// 4) Clean up the empty pending row:
document.activeElement.blur();   // removes the unnamed pending row
```

**Pass criteria:** `scroll events fired: 0` (before the fix this logs one or more
events — the visible jump), the new row's name input has focus, and the view does not
move when the row appears. Also confirm normal behavior is intact: type a name in the
new row and blur — it should persist; add another row and blur it while empty — it
should disappear.
