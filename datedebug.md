I've created C:\EXCEl\datedebug.md. Here's what it covers and what I found by tracing the code.

The behavior you saw (dev, SUB0 → SUB1)

Adding BRAIN > Hzw (ends 03/25/2027) triggers this chain in design.js:
1. .pred-dropdown-item click handler (line 1868)
2. isExecutionProject() — the master gate (line 900)
3. getStoredDuration() → syncStoredStartToEffective() → getEffectiveStartDate() → getLatestPredEnd() → nextWorkingDay() gives start = 03/26/2027
4. computeEndDateFromDuration() → addWorkingDays(start, 20) gives end = 04/22/2027

Most likely cause of the production discrepancy

Everything is gated behind:

function isExecutionProject() {
    return (PROJ_NAME || '').toLowerCase().indexOf('execution') !== -1;
}

It's a literal substring match on the project name. If your production project isn't named with the word "execution" (renamed, misspelled — note it does not match "exec"/"execute", only "execution"), the entire date-shift feature is silently off and dates never move. This is suspect #1.

The markdown file contains:
- A ranked checklist (5 gates) of what can differ between dev and production.
- The exact, full source of all 10 functions involved (predecessor-add handler, isExecutionProject, getEffectiveStartDate, getLatestPredEnd, nextWorkingDay, addWorkingDays, computeEndDateFromDuration, syncStoredStartToEffective, getStoredDuration, recalcDependents) with dev line numbers, so you can diff them against production.
- A fast-path console script to run in production right after reproducing the bug — whichever line first returns false/''/0 pinpoints the divergence.

A likely quick win: just compare the project name in dev vs. production (PROJ_NAME in the console). If production's name lacks "execution", that alone explains the whole difference. The second thing to rule out is a stale cached design.js in production (hard-refresh / compare the handler at line 1868 — an older build only saved the predecessor without the date math).



# Date-Shift Debug Guide — Predecessor doesn't move Start/End date in Production

## Symptom

- **Dev (working, SUB0 → SUB1):** "Software" subtask starts at `01/01/2027`, ends `01/28/2027`, no predecessor. After adding predecessor **BRAIN > Hzw** (which ends `03/25/2027`), the Software row shifts: **start → 03/26/2027** (next working day after the predecessor ends) and **end → 04/22/2027** (20 working days later).
- **Production (broken):** Exactly the same edit, but the Start/End dates **do not change**.

The shift you see in dev is produced by a specific chain of functions in `design.js`. If **any one** of the gates in that chain evaluates differently in production, the dates stay put. This file lists, in order of likelihood, what to check — and includes the **exact source** of every function involved so you can diff dev vs. production line-by-line.

---

## How the shift is supposed to happen (the chain)

1. You tick a predecessor in the dropdown → the `.pred-dropdown-item` click handler runs.
2. It calls **`isExecutionProject()`** — **this is the master gate.** If it returns `false`, *none* of the date logic runs and the dates never move.
3. It reads the duration via **`getStoredDuration()`**.
4. It stamps the new start via **`syncStoredStartToEffective()`** → **`getEffectiveStartDate()`** → **`getLatestPredEnd()`** → **`nextWorkingDay()`**.
5. It recomputes the end via **`computeEndDateFromDuration()`** → **`addWorkingDays()`**.
6. It cascades to dependents via **`recalcDependents()`**.

So the shift depends on **all** of these being true in production:

| # | Check | Why it matters |
|---|-------|----------------|
| **1** | **`PROJ_NAME` contains the word `execution` (case-insensitive)** | `isExecutionProject()` is a substring match on the project name. This is the **#1 suspect.** |
| **2** | The predecessor **BRAIN > Hzw actually resolves to a real task** with a usable end date | `getLatestPredEnd()` returns `''` if the predecessor task can't be found or has no end date and no derivable duration. |
| **3** | The Software row has a **duration** (either `_workingDays` or a start+end span) | `getStoredDuration()` returns `0` → the end date is never recomputed. |
| **4** | The predecessor picker click handler in production is **the same version** (calls the recalc functions, not just `setPredArray`) | Older builds only saved the predecessor and skipped the date math. |
| **5** | The five date helpers are **byte-identical** to dev | A subtle change to `addWorkingDays` / `nextWorkingDay` / `getEffectiveStartDate` breaks the result silently. |

---

## ⭐ Most likely cause: `isExecutionProject()` returns false in production

```js
function isExecutionProject() {
    return (PROJ_NAME || '').toLowerCase().indexOf('execution') !== -1;
}
```

This is a **substring match on the project name**. Every piece of the date-shift logic is gated behind it (see lines flagged below). If the production project is **not named with the word "execution"**, the feature is silently off.

**Check in production:**

1. Open the browser devtools console on the production page **after** opening the project, and run:
   ```js
   PROJ_NAME
   ```
   (or inspect it however the code is scoped — it's a `var` inside the IIFE; if not reachable, log it: temporarily add `console.log('PROJ_NAME=', PROJ_NAME)` after line 4315.)
2. Confirm the string contains `execution` after `.toLowerCase()`. Common mismatches that silently disable the feature:
   - Project renamed (e.g. `"BRAIN — Build"` instead of `"BRAIN Execution"`).
   - Misspelling (`"Excecution"`, `"Exec"`, `"Execute"` — note the code does **not** match `"exec"` or `"execute"`, only the literal substring `"execution"`).
   - A trailing/leading invisible character is fine (substring match), but a different word entirely is not.
   - Contrast with `isAssessmentProject()` which *does* tolerate the misspelling `"assesment"` — `isExecutionProject()` has **no** such tolerance.

`PROJ_NAME` is set in exactly three places — verify production loaded the project through one that sets the expected name:

```js
var PROJ_NAME = '';                       // line 8  (initial)
...
PROJ_NAME = name;                          // line 4315, openGroupProject(name)
...
PROJ_NAME = name;                          // line 4351, createGroupProject(name)
...
PROJ_NAME = DEFAULT_GROUP_PROJECT;         // line 5359
```

**If this is the cause:** rename the production project to include "execution", or (if you don't want to depend on the name) change `isExecutionProject()` to whatever the real intended condition is. **Verify dev and production have the same project name first** — that alone likely explains the whole difference.

---

## The exact functions to diff (dev vs. production)

Copy each block below and compare against the production `design.js`. The line numbers are from the current dev file.

### 1. The predecessor-add handler (`.pred-dropdown-item` click) — lines 1868–1955

This is the handler that fires when you tick a predecessor in the dropdown. **If production's copy of this block does not call `syncStoredStartToEffective` / `computeEndDateFromDuration` / `recalcDependents`, that's your bug** — it's an older build that only saved the predecessor.

```js
$(document).on('click', '.pred-dropdown-item', function (e) {
    e.stopPropagation();
    if ($(this).hasClass('pred-disabled')) return;
    var predId = parseInt($(this).attr('data-pred-id'));
    var preds = getPredArray();
    var idx = -1;
    for (var i = 0; i < preds.length; i++) {
        if (String(preds[i]) === String(predId)) { idx = i; break; }
    }
    if (idx !== -1) {
        preds.splice(idx, 1);
    } else {
        preds.push(predId);
    }
    setPredArray(preds);

    // Recalculate end date for the task whose predecessors changed
    var changedTask = null;
    if (activePredPickerTarget.type === 'header') {
        changedTask = findTaskById(selectedTaskId, tasks);
    } else {
        changedTask = findTaskById(activePredPickerTarget.id, tasks);
    }
    if (changedTask && isExecutionProject() && idx !== -1 && preds.length === 0) {
        // LAST predecessor removed (un-ticked in the dropdown). The
        // pre-shift start is not stored anywhere, so clear both dates
        // instead of keeping the shifted ones — an empty START DATE
        // makes it obvious the row needs a new date. WKNG DAYS is
        // preserved.
        changedTask.startDate = '';
        changedTask.endDate = '';
        saveData();
        sendPatch({ op: 'update', taskId: changedTask.id, field: 'startDate', value: '' });
        sendPatch({ op: 'update', taskId: changedTask.id, field: 'endDate', value: '' });
        recalcDependents(changedTask.id);
        if (changedTask.id === selectedTaskId &&
            !(changedTask.subtasks && changedTask.subtasks.length > 0)) {
            $('#detail-start-date').val('');
            $('#detail-end-date').val('');
        }
    } else if (changedTask) {
        // Duration must be read BEFORE the start is stamped: its fallback
        // derives from the stored start/end span.
        var dur = getStoredDuration(changedTask);
        if (syncStoredStartToEffective(changedTask)) {
            saveData();
            sendPatch({ op: 'update', taskId: changedTask.id, field: 'startDate', value: changedTask.startDate });
            if (changedTask.id === selectedTaskId &&
                !(changedTask.subtasks && changedTask.subtasks.length > 0)) {
                $('#detail-start-date').val(toDisplayDate(changedTask.startDate));
            }
        }
        if (dur > 0) {
            var newEnd = computeEndDateFromDuration(changedTask, dur);
            if (newEnd) {
                changedTask.endDate = newEnd;
                saveData();
                sendPatch({ op: 'update', taskId: changedTask.id, field: 'endDate', value: newEnd });
                recalcDependents(changedTask.id);
                // If this was the currently-displayed header task (leaf),
                // refresh the END DATE input so the UI reflects the new value.
                if (changedTask.id === selectedTaskId &&
                    !(changedTask.subtasks && changedTask.subtasks.length > 0)) {
                    $('#detail-end-date').val(toDisplayDate(newEnd));
                }
            }
        }
    }

    var filterVal = $('#pred-search-filter').val() || $(activePredPickerEl).find('.pp-filter-input').val();
    renderPredDropdownList(filterVal);

    var $picker = $(activePredPickerEl);
    buildPredecessorChips($picker, preds);

    // Refresh subtask table to show updated end dates
    var parentTask = findTaskById(selectedTaskId, tasks);
    if (parentTask) {
        syncParentStartDate(parentTask);
        syncParentEndDate(parentTask);
        renderSubtaskTable(parentTask);
    }

    // Refresh header badges whenever the selected task's predecessors change
    if (activePredPickerTarget.type === 'header') {
        updateHeaderEndDateBadges(findTaskById(selectedTaskId, tasks));
    }
});
```

### 2. `isExecutionProject()` — the master gate — line 900

```js
function isExecutionProject() {
    return (PROJ_NAME || '').toLowerCase().indexOf('execution') !== -1;
}
```

### 3. `getEffectiveStartDate()` — computes the shifted start — line 2335

```js
// Get the effective start date for a task considering its predecessor chain.
// If predecessors exist, effective start = next working day after the latest predecessor end date.
// Uses a visited set to prevent circular references.
function getEffectiveStartDate(taskObj, visited) {
    if (!visited) visited = {};
    if (!taskObj) return '';
    if (visited[taskObj.id]) return taskObj.startDate || ''; // circular ref guard
    visited[taskObj.id] = true;

    ensurePredecessorArray(taskObj);
    if (!taskObj.predecessor || taskObj.predecessor.length === 0) {
        return taskObj.startDate || '';
    }

    var maxEndDate = getLatestPredEnd(taskObj, visited);
    if (maxEndDate) {
        return nextWorkingDay(maxEndDate);
    }
    return taskObj.startDate || '';
}
```

### 4. `getLatestPredEnd()` — finds the predecessor's end date — line 2305

If **BRAIN > Hzw** cannot be found by `findTaskById`, or it has no `endDate` and no derivable duration, this returns `''` and **the start never shifts**. In production, confirm the predecessor task actually exists and has an end date (`03/25/2027`).

```js
// Latest end date (ISO) across a task's predecessors, '' when none can
// be resolved. Predecessors without a stored end date get one computed
// from their own chain (effective start + working days).
function getLatestPredEnd(taskObj, visited) {
    if (!visited) visited = {};
    if (!taskObj) return '';
    ensurePredecessorArray(taskObj);
    if (!taskObj.predecessor || taskObj.predecessor.length === 0) return '';

    var maxEndDate = '';
    for (var i = 0; i < taskObj.predecessor.length; i++) {
        var pred = findTaskById(taskObj.predecessor[i], tasks);
        if (!pred) continue;

        var predEnd = pred.endDate || '';
        if (!predEnd) {
            var predDays = getStoredDuration(pred);
            if (predDays > 0) {
                var effStart = getEffectiveStartDate(pred, visited);
                if (effStart) predEnd = addWorkingDays(effStart, predDays);
            }
        }

        if (predEnd && predEnd > maxEndDate) {
            maxEndDate = predEnd;
        }
    }
    return maxEndDate;
}
```

### 5. `nextWorkingDay()` — line 2293

```js
// Return the next working day (Mon-Fri) after a given ISO date
function nextWorkingDay(isoDate) {
    var cur = new Date(isoDate + 'T00:00:00');
    cur.setDate(cur.getDate() + 1);
    while (cur.getDay() === 0 || cur.getDay() === 6) {
        cur.setDate(cur.getDate() + 1);
    }
    return cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
}
```

### 6. `addWorkingDays()` — computes the new end date — line 2277

```js
// Add working days to a start date and return the end ISO date string
function addWorkingDays(startIso, numDays) {
    var cur = new Date(startIso + 'T00:00:00');
    if (numDays <= 0) return startIso;
    var count = 0;
    while (true) {
        var day = cur.getDay();
        if (day !== 0 && day !== 6) {
            count++;
            if (count === numDays) break;
        }
        cur.setDate(cur.getDate() + 1);
    }
    return cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
}
```

### 7. `computeEndDateFromDuration()` — line 2354

Note this **also** calls `isExecutionProject()`. In a non-execution project it uses the raw stored start instead of the effective (shifted) start — another reason a non-execution project won't shift.

```js
// Compute end date from duration, accounting for predecessors (Execution only)
function computeEndDateFromDuration(taskObj, numDays) {
    var startDate;
    if (isExecutionProject()) {
        startDate = getEffectiveStartDate(taskObj);
    } else {
        startDate = taskObj.startDate || '';
    }
    if (!startDate) return '';
    return addWorkingDays(startDate, numDays);
}
```

### 8. `syncStoredStartToEffective()` — line 2371

Also gated on `isExecutionProject()`. This is what actually writes the shifted start (`03/26/2027`) back into the row.

```js
// Execution: keep the STORED start date of a leaf in sync with its
// effective start (next working day after the latest predecessor ends).
// End dates are already computed from the effective start, so this can
// never change an end date — it only stops the START DATE column from
// showing the stale pre-dependency date. Returns true when the stored
// value changed; the caller is responsible for saveData/sendPatch.
function syncStoredStartToEffective(taskObj) {
    if (!isExecutionProject()) return false;
    if (!taskObj || (taskObj.subtasks && taskObj.subtasks.length > 0)) return false;
    ensurePredecessorArray(taskObj);
    if (!taskObj.predecessor || taskObj.predecessor.length === 0) return false;
    var eff = getEffectiveStartDate(taskObj);
    if (!eff || eff === taskObj.startDate) return false;
    taskObj.startDate = eff;
    return true;
}
```

### 9. `getStoredDuration()` — line 2384

If production's Software row has **no** `_workingDays` and no start/end span, this returns `0` and the end date is never recomputed (`if (dur > 0)` guard fails). The dev row shows `20d`, so it should be fine — but verify `_workingDays` survived whatever import/copy created the production data.

```js
// Get the stored working days for a task.
// Uses _workingDays if available (user-entered), otherwise falls back to calcDuration.
function getStoredDuration(taskObj) {
    if (!taskObj) return 0;
    if (taskObj._workingDays && taskObj._workingDays > 0) return taskObj._workingDays;
    if (!taskObj.startDate || !taskObj.endDate) return 0;
    var dur = calcDuration(taskObj.startDate, taskObj.endDate);
    if (!dur) return 0;
    var num = parseInt(dur.replace(/[^0-9]/g, ''));
    return isNaN(num) ? 0 : num;
}
```

### 10. `recalcDependents()` — cascade — line 2395

```js
// Recalculate end dates for all tasks that depend on changedTaskId, cascading
function recalcDependents(changedTaskId, visited) {
    if (!visited) visited = {};
    if (visited[changedTaskId]) return;
    visited[changedTaskId] = true;

    // Flatten ALL tasks and subtasks in the project
    var allItems = [];
    function collectAll(list) {
        for (var i = 0; i < list.length; i++) {
            allItems.push(list[i]);
            if (list[i].subtasks && list[i].subtasks.length > 0) {
                collectAll(list[i].subtasks);
            }
        }
    }
    collectAll(tasks);

    for (var i = 0; i < allItems.length; i++) {
        var item = allItems[i];
        ensurePredecessorArray(item);
        var dependsOnChanged = false;
        for (var j = 0; j < item.predecessor.length; j++) {
            if (String(item.predecessor[j]) === String(changedTaskId)) {
                dependsOnChanged = true;
                break;
            }
        }
        if (!dependsOnChanged) continue;

        // This item depends on the changed task — recalculate its end date
        var dur = getStoredDuration(item);
        if (dur > 0) {
            var newEnd = computeEndDateFromDuration(item, dur);
            if (newEnd && newEnd !== item.endDate) {
                item.endDate = newEnd;
                saveData();
                sendPatch({ op: 'update', taskId: item.id, field: 'endDate', value: newEnd });
                // Cascade to anything depending on this item
                recalcDependents(item.id, visited);
            }
        }
        if (syncStoredStartToEffective(item)) {
            saveData();
            sendPatch({ op: 'update', taskId: item.id, field: 'startDate', value: item.startDate });
        }
    }
}
```

---

## Fast path to the answer

Run these in the production browser console right after reproducing the bug (adding the predecessor):

```js
// 1. Is the feature even on?
isExecutionProject();          // must be true; if false → PROJ_NAME is wrong
PROJ_NAME;                     // must contain "execution" (lowercased)

// 2. Does the predecessor resolve and have an end date?
//    (replace SOFTWARE_ID with the Software subtask's id)
var sw = findTaskById(SOFTWARE_ID, tasks);
sw.predecessor;                        // should list BRAIN > Hzw's id
getLatestPredEnd(sw, {});              // should be "2027-03-25"
getEffectiveStartDate(sw, {});         // should be "2027-03-26"
getStoredDuration(sw);                 // should be 20
computeEndDateFromDuration(sw, 20);    // should be "2027-04-22"
```

Whichever line first returns an empty string / `false` / `0` pinpoints the discrepancy:

- `isExecutionProject()` false → **project name** (most likely).
- `getLatestPredEnd` empty → the predecessor task isn't found or has no end date in production's data.
- `getStoredDuration` 0 → the `_workingDays` didn't carry over.
- All correct but dates still don't move on click → the **production `.pred-dropdown-item` handler is an older build** (block #1 above); diff it.

## Also worth confirming

- **Is production actually running the same `design.js`?** Check for a cached/older bundle: compare file size / a `git log` / a build hash, and hard-refresh (Ctrl+F5) to rule out a stale cached script.
- **Server-side:** the client sends `sendPatch(...)` for each date change. If production's dates change locally but revert, the issue is the server not persisting the patch — but that's a *different* symptom than "don't change at all". The checks above assume the client-side change never happens.
