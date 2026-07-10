# broadcastfix.md — Fix instructions: browser freeze when view.html receives patches from design.html

**Audience:** Claude (Opus 4.8) working on *modified* copies of `view.js` and `design.js` on the server.
**Origin:** Diagnosed 2026-07-10 on the reference copy with a live socket trace and main-thread
instrumentation, against a large Execution project (~3,000 tasks, ~730 nodes under one
top-level task). This is a companion document to `fixshift.md` — apply that one first if it
hasn't been applied yet; the two are independent but related.

**IMPORTANT — how to use this document:**
- Do **NOT** use line numbers. The server's files differ from the reference copy. Locate
  every change by **function name**, **jQuery selector**, or the **code patterns** quoted below.
- Names may differ on the server; each fix also describes how to find the code by behavior.
- Apply fixes surgically. Do not refactor, rename, or "improve" adjacent code.
- Run the verification at the bottom after applying.

---

## The bug being fixed (symptom)

User has `design.html` open, and `view.html` open **in another window/tab of the same
browser**, both on the same large project:

- Clicking the **“+” (Add sub-subtask)** button in design.html freezes the browser for
  many seconds.
- Firefox shows a banner: *“View is slowing down Firefox. Stop it to speed up this page.”*
  — blaming the **view.html** tab.
- When view.html is **not** open anywhere in that browser, the problem disappears
  (apart from design.html's own render time, covered by `fixshift.md`).

## Root cause chain (confirmed by live socket trace)

1. **design.html broadcasts on every + click, even when nothing changed.** The add
   handlers call `recomputePercentComplete()` and `recomputeCost()`, and **both end with
   an unconditional `sendPatch(...)`** (`op:'update'`, fields `percentComplete` and
   `cost`). A live trace captured exactly 2 patches per + click. Side effect: the % patch
   folds the not-yet-named pending row (0%) into the parent's average, so *merely
   clicking +* can rewrite the parent's percentComplete on the server before the user
   types anything.
2. **design.html does NOT wait for any acknowledgement** — `sendPatch` uses a
   fire-and-forget `socket.emit` (the ack callback only shows a failure toast). The
   freeze is not network waiting.
3. **The server rebroadcasts each patch** to every client in the project room —
   including the user's own view.html tab (different clientId, so its self-filter does
   not skip it).
4. **view.html's patch handler is extremely heavy per patch.** In
   `handleIncomingGridPatch` (view.js), one incoming `update` patch runs:
   - `findTaskInPreserved(taskId)` — full walk of the entire task tree;
   - `findTaskRowIndex(taskId)` — another full walk;
   - for `percentComplete` patches, `cascadeAncestorPercents(taskId)` — an additional
     `findTaskRowIndex` walk *per ancestor* plus cell re-renders;
   - **`saveToLocalStorage()` up to three times per patch.** Each call runs
     `collectState()`, which deep-copies **every cell** in the grid
     (`$.extend(true, {}, cellData)`), deep-copies and rebuilds the **entire task tree**
     (`buildTaskDataFromCells`), and reads `$th.outerWidth()` per column — a forced
     synchronous layout reflow. Measured at **~1 second or more per call** on large data.
   Two patches × up to three `collectState()` copies each = many seconds of blocked
   main thread in view.html.
5. **The browsers couple the two tabs.** Firefox places same-origin tabs in the same
   content process (one main thread); Chrome groups same-site tabs similarly. When
   view.html blocks, design.html — same origin, same process — freezes with it.
   Firefox's slow-script detector names the tab running the code: "View".
   Corollary: if view.html is open **on another computer**, the freeze happens on *that*
   computer, not on the editor's — process sharing is per-browser, not per-network.
6. **The most expensive work is wasted.** In the reference copy,
   `loadFromLocalStorage()` in view.js is dead code — **nothing ever calls it** — so the
   `saveToLocalStorage()` writes are a cache nobody reads. On very large projects the
   `localStorage.setItem` call also silently throws `QuotaExceededError` (browser cap is
   ~5–10 MB), meaning the full serialize cost is paid and *nothing is even stored*.

---

## Fix A — view.js: stop the per-patch state deep-copy (the freeze killer)

### Pre-check (do this first)

Search view.js for calls to `loadFromLocalStorage`. In the reference copy the function
is defined but **never called**. Confirm the same on the server copy:

- **If it is never called:** the localStorage cache is write-only dead weight → proceed
  with the removal below.
- **If the server copy DOES call it somewhere** (their version is modified): do not
  remove the saves; instead **debounce** them (see "Alternative" below).

### Where to find it

Function `handleIncomingGridPatch(data)` — the `socket.on('patch', ...)` handler in
view.js. It dispatches on `data.op` (`'updateCell'`, `'update'`, `'updateComment'`,
structural ops). Inside it, `saveToLocalStorage()` is called at several points:

- in the `updateCell` branch, right after `cellData[key]` is assigned;
- in the `update` branch, after the mapped cell text is written;
- in the `update` branch's status→percent derivation sub-block (leaf status patches);
- in the `update` branch's `percentComplete` sub-block (after `cascadeAncestorPercents`);
- in the `updateComment` branch, after the comment is pushed.

### What to change

**Delete every `saveToLocalStorage();` call inside `handleIncomingGridPatch`** (all
branches). Leave the function definition itself and all its *other* call sites (undo/
redo, local edit paths, etc.) untouched. Add a short comment where the calls were, e.g.:

```javascript
// saveToLocalStorage() intentionally NOT called here: it deep-copies the
// entire grid state via collectState() (~1s+ on large projects) on every
// incoming patch, freezing this tab — and any same-origin tab sharing the
// browser process (design.html). The localStorage snapshot is never read
// back (loadFromLocalStorage has no callers), so nothing is lost.
```

### Alternative (only if the server copy actually reads the cache)

Keep persistence but take it off the hot path with a trailing debounce:

```javascript
var _lsSaveTimer = null;
function scheduleLocalStorageSave() {
    if (_lsSaveTimer) clearTimeout(_lsSaveTimer);
    _lsSaveTimer = setTimeout(function () {
        _lsSaveTimer = null;
        saveToLocalStorage();
    }, 2000);
}
```

…and replace each `saveToLocalStorage()` call inside `handleIncomingGridPatch` with
`scheduleLocalStorageSave()`. A burst of patches then costs one deep-copy two seconds
after the burst ends, instead of one per call.

---

## Fix B — design.js: only broadcast recomputed values that actually changed

### Where to find it

Two functions in design.js:

- `recomputePercentComplete()` — recomputes the selected top-level task's percent from
  its children and **ends with an unconditional**
  `sendPatch({op:'update', ..., field:'percentComplete', ...})`.
- `recomputeCost()` — same pattern, `field:'cost'`.

(`recomputeStatus()` already sends only on change — use it as the in-file reference for
the intended pattern.)

These functions are called from many places (add subtask, add sub-subtask, delete,
blur handlers, field edits). Fixing them at the source fixes every call site.

### What to change

Capture the old value before recomputing; send the patch (and ideally the
`saveData()` write) only when the value changed. Pattern for
`recomputePercentComplete()`:

```javascript
function recomputePercentComplete() {
    var task = findTaskById(selectedTaskId, tasks);
    if (!task) return;
    var oldPct = task.percentComplete;                 // ← capture
    if (!task.subtasks || task.subtasks.length === 0) {
        task.percentComplete = 0;
    } else {
        computePercentFromChildren(task);
    }
    $('#detail-percent').val(task.percentComplete);
    updateSubtaskPercentCells(task.subtasks || []);
    saveData();
    if (task.percentComplete !== oldPct) {             // ← only if changed
        sendPatch({op: 'update', taskId: task.id, field: 'percentComplete', value: task.percentComplete});
    }
}
```

Same change in `recomputeCost()`. Costs may be stored as string or number, so compare
numerically:

```javascript
var oldCost = task.cost;
// ... existing recompute ...
if ((parseFloat(task.cost) || 0) !== (parseFloat(oldCost) || 0)) {
    sendPatch({op: 'update', taskId: task.id, field: 'cost', value: task.cost});
}
```

Result: clicking “+” on a subtask whose parent's rolled-up values don't change sends
**zero** broadcasts, so an open view.html does nothing at all.

---

## Fix C (optional, recommended) — design.js: exclude uncommitted pending rows from parent roll-ups

Newly added rows carry `_pendingAdd = true` until the user names them (they are removed
again if left unnamed). Folding them into parent averages is what makes a mere + click
change the parent's % (a 0% row enters the average) — which then still broadcasts even
with Fix B, and reverts when the pending row is abandoned.

### Where to find it

The child-aggregation helpers in design.js, found by behavior — each loops over
`node.subtasks` combining child values into the parent:

- `computePercentFromChildren(node)` — sums `percentComplete` / counts children
  (skipping `status === 'Cancelled'`);
- `computeCostFromChildren(node)` — sums `parseFloat(cost)`;
- `computeStatusFromChildren(node)` — derives parent status.

### What to change

In each aggregation loop, skip pending rows the same way Cancelled rows are skipped:

```javascript
if (node.subtasks[i]._pendingAdd) continue;   // uncommitted row — not real yet
```

Note for `computePercentFromChildren`: the skip must not increment the divisor
(`count`) either — place the `continue` before both the sum and the count, exactly
like the existing Cancelled skip. When ALL children are pending (first child just
added), the parent keeps its previous value — that is the desired behavior.

Do **not** skip `_pendingAdd` rows anywhere else (rendering must still show them; the
blur handler must still find them).

---

## What NOT to change

- Do **not** remove the `recompute*()` calls from the add/delete/blur handlers —
  `fixshift.md` already covers why they must stay. Fix B makes them cheap to keep.
- Do **not** touch the server's broadcast logic (`handle_send_patch`,
  `include_self=False`, the `noBroadcast` flag, or the HTTP fallback's broadcast).
- Do **not** remove the `data.clientId === CLIENT_ID` self-filter at the top of
  `handleIncomingGridPatch` — it is required by the HTTP fallback path.
- Do **not** remove `saveToLocalStorage`/`saveData` calls outside
  `handleIncomingGridPatch` — undo/redo and local-edit paths still use them.
- Leave `cascadeAncestorPercents` and the two `findTask*` walks alone for now. They are
  O(n) per patch but only milliseconds; with Fix A and B in place they no longer matter.

## Expected result

| Scenario | Before | After |
|---|---|---|
| + click with view.html open, same browser | multi-second freeze of BOTH tabs, Firefox "View is slowing down" banner | no freeze; usually zero patches sent |
| + click, parent roll-up genuinely changes | freeze | one small patch; view.html updates the affected cells in milliseconds |
| view.html on another computer | that computer's view.html freezes on every patch burst | unaffected or trivial per-patch work |

---

## Verification (browser DevTools console)

**1. Count broadcasts per + click.** In ANY tab on the app origin (or a third tab), open
an observer socket and join the project room (adjust the project name):

```javascript
var obs = io();
obs.emit('join_project', { project: 'INTL_to_ITServices_Execution' });
window.__patches = [];
obs.on('patch', function (d) { window.__patches.push({ op: d.op, field: d.field }); });
```

Click “+” next to a subtask in design.html, wait 2 s, then check `window.__patches`:
- **After Fix B (+C):** empty array in the common case (no roll-up change).
- **Before:** two entries — `update/percentComplete` and `update/cost` — on every click.

**2. Confirm view.html no longer blocks.** In the view.html tab:

```javascript
window.__blocks = [];
var last = performance.now();
setInterval(function () {
    var now = performance.now();
    if (now - last > 200) window.__blocks.push(Math.round(now - last));
    last = now;
}, 25);
```

(The tab must stay foregrounded — background tabs throttle timers and fake the
numbers.) Make an edit in design.html that genuinely changes a value (e.g. a leaf's
cost). `window.__blocks` must stay empty or show only small (<200 ms) entries.
Before Fix A, each incoming patch produced 1s+ block entries.

**3. The Firefox test (the original symptom).** Firefox, same profile: view.html in one
window, design.html in another, large project. Click “+” several times and type names.
The "View is slowing down Firefox" banner must not appear, and design.html must stay
responsive.

**4. Regression checks.** After the fixes: change a leaf's status in design.html →
view.html's status cell updates and flashes; change a leaf's % → parent's rolled-up %
cell updates in view.html; add + name a subtask → view.html shows the yellow
"row was added — Refresh" banner. All of these must still work.
