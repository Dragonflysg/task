# Comments Column Duplication — Root Cause Analysis

**Date:** 2026-07-06
**Files involved:** `view.html`, `view.js`, `design.js`, `controllers_server.py`
**Status:** Diagnosis only — no source files have been modified. Proposed fix at the bottom of this document.

---

## 1. Background: how view.html receives live updates

`view.html` loads `view.js` plus the Socket.IO client (`view.html:458-463`). The page participates in a
WebSocket "room" per project and receives every change other clients make as a **patch broadcast**.

| What | Where |
|---|---|
| Socket connection opened | `view.js:73` — `var socket = io();` |
| Join per-project room | `view.js:92-100` — `joinProjectRoom()` emits `join_project` |
| **The broadcast listener** | `view.js:88-90` — `socket.on('patch', ...)` → `handleIncomingGridPatch(data)` |
| Patch applier | `view.js:267-485` — `handleIncomingGridPatch()` |
| Cell re-render | `view.js:2340` — `renderSingleCell()` (plus `flashRemoteCell()` at `view.js:206`) |

`handleIncomingGridPatch` handles these operations:

- **`updateCell`** (`view.js:270-291`) — positional cell edit from another View client. Writes
  `cellData[key]` (key = `"row-col"`), re-renders the `<td>`. If the column is the Comments column,
  also copies the text into `taskObj.comments` (`view.js:277-284`).
- **`update`** (`view.js:294-451`) — task-field change from design.html. Maps field → column via
  `TASK_FIELD_TO_COL` (`view.js:149-152`), finds the row via `findTaskRowIndex()`, updates the cell.
  Includes ripple logic (duration re-render, status ⇄ %-complete derivation, ancestor % cascade).
- **`updateComment`** (`view.js:454-472`) — sidebar admin-comment threads.
- **`addTask` / `deleteTask` / `addSubtask` / `deleteSubtask`** (`view.js:477-484`) — structural
  changes. **These do not modify the grid.** They only show the yellow banner
  ("…Refresh to see the latest changes").

Server side (`controllers_server.py`):

- WebSocket patches: `handle_send_patch` (`:1070-1090`) applies the patch and broadcasts to the room
  — **unless the patch carries `noBroadcast: true`** (`:1083`).
- HTTP fallback `/api/patch-task`: `patch_task` (`:1026-1049`) applies the patch and **always
  broadcasts** (`:1043`), even though the client comment for admin columns claims it saves "without
  WebSocket broadcast".

---

## 2. The Comments column is stored differently from every other column

**Every other column** stores its text in exactly one place: `cellData`, keyed by **grid position**
(`"row-col"`, e.g. `"7-9"`). The text belongs to a coordinate, not to a task. Server-side, an
`updateCell` patch just writes `data['cellData'][key]` (`controllers_server.py:826-833`).

**The Comments column** is dual-stored, and the authoritative copy lives on the **task object**
(`task.comments`), keyed by task ID:

- Identified **by header name**: `getCommentsColIndex()` looks for a column literally named
  `Comments` (`view.js:1328-1333`). No other column gets name-based treatment.
- Tagged `isAdminColumn = true` on every load (`view.js:1752-1757`) — editable by super users only.
- **Double write on edit** (`view.js:2979-3009` in `finishEditing`): writes `cellData` like a normal
  cell (saved via `saveAdminCell`, `view.js:129-146`, chosen at `view.js:3027-3029`), **and** sends a
  second task-level patch `op:'update', field:'comments', noBroadcast:true` so the server stores the
  text on the task object (`controllers_server.py:850`).
- **On load, `task.comments` wins**: declared "single source of truth" (`view.js:1705`);
  `syncCellDataFromTaskData` overwrites every Comments cell from task data (`view.js:1476-1480`) and
  wipes stale comment cells beyond the task count (`view.js:1509-1517`).
- `loadState` has ~150 lines of Comments-only machinery (`view.js:1555-1701`): flushing unsaved cell
  edits into task objects, building an ID→comment map, transferring comments onto the newly loaded
  task objects, and **seeding `task.comments` from positional cellData on first load** — see §3.
- The server has a matching migration, `_migrate_celldata_comments_to_tasks`
  (`controllers_server.py:348-371`), whose docstring states the reason for the whole design:
  *"after structural changes (add/delete subtask) the row-col positions in cellData are stale and
  would map the wrong comment to the wrong task."*

> Note: don't confuse the Comments **column** (`task.comments`) with the sidebar "Admin Comments"
> **thread** (`rowComments`, keyed `tid_<taskId>`, `view.js:28` / `view.js:454-472`). They are
> unrelated storage-wise.

---

## 3. The bug: Comments values duplicated into rows above/below

### Reported symptom

Values in the Comments column appear duplicated in other rows (above or below the original).
Suspected trigger: adding subtasks / sub-subtasks in design.html while view.html is open.
Never reproducible by the developers.

### Three facts that combine into the bug

**Fact 1 — The server's Comments cellData is never re-aligned after structural changes.**
design.html only sends `addSubtask`-style patches, which append to `_taskData`
(`controllers_server.py:896-909`) and never touch `cellData`. Nothing else fixes it either:

- view.html never full-saves: `saveToServer()` is a **no-op** (`view.js:1793-1796`);
- design.js's full-save builder `buildSaveData()` is **dead code** (defined at `design.js:3888`,
  never called);
- the server migration explicitly refuses to read cellData (`controllers_server.py:351-355`).

So once a Comments cell is edited at row *r*, that text sits **fossilized** at server
`cellData["r-col"]` forever, while the rows shift underneath it with every structural change.

**Fact 2 — On every fresh page load, view.js seeds empty task comments from that positional
cellData.** In `loadState`, branch (b) at `view.js:1660-1668` runs whenever `hasOldComments` is
false. Because `loadFromLocalStorage()` is never called (dead code, `view.js:1782`) and
`preservedTaskData` is null at startup, `hasOldComments` is false on **every first load of the
page** — not just for legacy migrations. The code walks the *current* hierarchy row by row and, for
any task whose `comments` is empty, copies whatever text the stale cellData holds at that row.
The inline comment says *"positions still aligned"* — that assumption is false the moment
design.html has inserted or deleted a row since the comment was last edited.

**Fact 3 — The wrong assignment is silently made permanent.** `view.js:1676-1701` pushes every
seeded value to the server as `op:'update', field:'comments'` with `noBroadcast: true`. The wrong
comment is now stored on the wrong task **for everyone**, and no client visibly reacts when it
happens.

### Step-by-step walkthrough

1. Admin edits Comments on task **T** at row 7. Server now has `cellData["7-c"] = "call vendor"`
   **and** `T.comments = "call vendor"`. Correct.
2. Someone in design.html adds a subtask above row 7. Server `_taskData` shifts T down to row 8.
   `cellData["7-c"]` still says "call vendor" (Fact 1).
3. Any user opens view.html **fresh** (new tab / F5 / next morning). Seeding runs (Fact 2): the task
   now sitting at row 7 — often the new subtask itself, whose `comments` is `''` — inherits
   `"call vendor"` from the fossil cell. T keeps its own copy via `task.comments`.
4. Result: **"call vendor" on two rows**, and the seed patch (Fact 3) persists the wrong copy
   server-side → permanent.
5. The fossil cell is never cleaned up, so each *subsequent* structural change can re-align it with
   yet another empty-comment task on a later fresh load — the comment can multiply over time.

**Why "above or below":** an insertion shifts rows down, so the duplicate appears **above** the
original; a deletion shifts rows up, so it appears **below**.

### Why it could never be replicated

- Testing live sync, you naturally click the banner's **Refresh** button (`#sc-refresh`,
  `view.js:494-504`) or reload within the same session. That path enters `loadState` with
  `preservedTaskData` populated → `oldTaskComments` non-empty → `hasOldComments` true → **seeding is
  skipped** and comments transfer safely by task ID (`view.js:1654-1657`). The bug only fires on a
  fresh page load — the one path a developer watching live sync rarely takes.
- Even on a fresh load, it needs a task with an **empty** comment to land on a fossil row
  (the `!taskObj.comments` guard makes commented tasks immune). Sequence-dependent.
- The corrupting patch is `noBroadcast`, so nothing visible happens at the moment of corruption.

### How to reproduce on demand

1. In view.html (as super user), edit a Comments cell on a mid-sheet task.
2. In design.html, add a subtask under an **earlier** parent (any insertion above that row).
3. Open view.html in a **new tab** (fresh load — do *not* use the banner's Refresh button).
4. The comment appears on two rows, and reloading again shows it persisted.

### Secondary (transient) variant

A client that hasn't refreshed after a structural change (banner still showing) edits a Comments
cell. The outgoing `updateCell` patch is positional; a client that *has* refreshed applies it to a
different row and even writes the wrong `taskObj.comments` locally (`view.js:277-284`). This variant
self-heals on the next refresh (server truth wins), but produces the same "comment on the wrong
row" appearance live. Worth hardening later (key Comments sync by task ID, not position), but it is
not the persistent corruption source.

### Related observations (follow-ups, not the reported bug)

- **Cross-project ID bleed:** when switching projects via the picker, `loadState` runs while
  `preservedTaskData` still holds the *previous* project. Transfer branch (a)
  (`view.js:1655-1657`) matches by bare task ID, and IDs collide across projects — an
  empty-comment task in project B can inherit the comment of same-ID task from project A (locally).
- **Inconsistent row-walk rules:** `findTaskRowIndex` (`view.js:154`) and `getTaskIdForRow`
  (`view.js:5013`) skip unnamed tasks only at the top level, while `buildTaskRowMap` /
  `syncCellDataFromTaskData` skip unnamed tasks at every level. Any unnamed subtask in the data
  makes these functions disagree by one row.

---

## 4. The fix

The corrupting code is the **positional seeding path** inside `loadState()` — the
"Transfer comments" block and the "Persist first-load seeded comments" block
(`view.js:1642-1701`). `task.comments` is already the single source of truth and is kept current by
`op:'update'` patches on every edit, so the positional fallback is unnecessary — and provably
harmful after any structural change.

### 4.1 Original code — `view.js:1642-1701` (inside `loadState()`)

```javascript
        // Transfer comments to new task objects.
        // Two sources: (a) oldTaskComments map (flushed from prior state, keyed by ID),
        // (b) cellData (only safe on first load when positions are still aligned).
        var _seededFromCellData = [];
        if (preservedTaskData && preservedTaskData.tasks) {
            var hasOldComments = Object.keys(oldTaskComments).length > 0;
            var _seedCommCol = getCommentsColIndex();
            var _seedRow = 0;
            function _transferComments(taskObj) {
                if (!taskObj.name || !taskObj.name.trim()) return;
                var currentSeedRow = _seedRow;
                _seedRow++;
                // (a) From prior state by task ID (structural changes safe)
                if (!taskObj.comments && hasOldComments && taskObj.id !== undefined) {
                    var saved = oldTaskComments[String(taskObj.id)];
                    if (saved) taskObj.comments = saved;
                }
                // (b) First load only: seed from cellData (positions still aligned)
                if (!taskObj.comments && !hasOldComments && _seedCommCol >= 0) {
                    var cd = cellData[currentSeedRow + '-' + _seedCommCol];
                    if (cd && cd.text) {
                        taskObj.comments = cd.text;
                        // Track seeded tasks so we can persist to server
                        if (taskObj.id !== undefined) {
                            _seededFromCellData.push({id: taskObj.id, comments: cd.text});
                        }
                    }
                }
                if (!taskObj.comments) taskObj.comments = '';
                $.each(taskObj.subtasks || [], function (i, s) { _transferComments(s); });
            }
            $.each(preservedTaskData.tasks, function (i, t) { _transferComments(t); });
        }

        // Persist first-load seeded comments to server so they survive future
        // structural changes (cellData positions will go stale after that).
        if (_seededFromCellData.length > 0 && PROJ_NAME) {
            $.each(_seededFromCellData, function (i, item) {
                var _seedPatch = {
                    op: 'update',
                    project: PROJ_NAME,
                    user: CURRENT_USER_ID,
                    clientId: CLIENT_ID,
                    taskId: item.id,
                    field: 'comments',
                    value: item.comments,
                    noBroadcast: true
                };
                if (socket && socketConnected) {
                    socket.emit('send_patch', _seedPatch);
                } else {
                    $.ajax({
                        url: '/api/patch-task',
                        method: 'POST',
                        contentType: 'application/json',
                        data: JSON.stringify(_seedPatch)
                    });
                }
            });
        }
```

### 4.2 Corrected code

Replaces the entire block above. Source (b) and the seed-persist block are removed; source (a)
— safe, because it is keyed by task ID — is kept.

```javascript
        // Transfer comments to new task objects.
        // Single source: the oldTaskComments map (flushed from prior state,
        // keyed by task ID), which is safe across structural changes.
        //
        // The old source (b) — seeding task.comments positionally from
        // cellData on first load — was removed. Server-side cellData for the
        // Comments column is never re-aligned after structural changes
        // (addSubtask/deleteSubtask patches only touch _taskData), so any
        // fresh page load that followed a structural change copied a
        // neighbouring task's comment into whatever task now occupied the old
        // row, then persisted that wrong mapping to the server — the cause of
        // the duplicated-Comments bug. task.comments (kept current via
        // op:'update' patches on every edit) is the single source of truth;
        // no positional fallback is needed.
        if (preservedTaskData && preservedTaskData.tasks) {
            var hasOldComments = Object.keys(oldTaskComments).length > 0;
            function _transferComments(taskObj) {
                if (!taskObj.name || !taskObj.name.trim()) return;
                // From prior state by task ID (structural changes safe)
                if (!taskObj.comments && hasOldComments && taskObj.id !== undefined) {
                    var saved = oldTaskComments[String(taskObj.id)];
                    if (saved) taskObj.comments = saved;
                }
                if (!taskObj.comments) taskObj.comments = '';
                $.each(taskObj.subtasks || [], function (i, s) { _transferComments(s); });
            }
            $.each(preservedTaskData.tasks, function (i, t) { _transferComments(t); });
        }
```

### 4.3 Review notes for the fix

1. **Legacy-data consideration.** Seeding existed to migrate projects created before
   `task.comments` was introduced. Any project opened in view.html since then has already been
   seeded (and persisted via the seed patches). If a never-opened legacy project might still exist,
   do that migration **once, server-side** (offline or inside `load_group`) where it can be gated
   properly — not on every client page load.
2. **Optional cleanup (recommended):** strip the fossil Comments-column entries out of server
   `cellData` (one-off script, or in `load_group` before returning). The client rebuilds all
   Comments cells from `task.comments` via `syncCellDataFromTaskData` anyway (`view.js:1706-1708`),
   so those positional entries are pure liability. This also kills residual risk from the transient
   variant in §3.
3. **After the fix**, duplicates already written to the data by past seeding are *not* auto-healed —
   they live in `task.comments` of the wrong tasks. Clear them once by editing/clearing the wrong
   cells in view.html (which patches the correct task IDs), or with a one-off data cleanup.
4. **Follow-up hardening (separate change):** key the live Comments sync by task ID instead of grid
   position (the `updateCell` handling at `view.js:277-284` and the admin save path), and align the
   unnamed-task skip rules between `findTaskRowIndex` / `getTaskIdForRow` and
   `buildTaskRowMap` / `syncCellDataFromTaskData`.

---

## 5. Recommendation: server restarts and the write-behind cache

*(Added after reviewing where project JSON files are stored and how they are persisted.
No code changes made — the system is in production.)*

### How persistence works

Project JSON files live in `C:\EXCEl\GROUP\<project>.json` (`GROUP_DIR`,
`controllers_server.py:190`; filenames sanitized at `:156-157` / `:814-815`). Backups go to
`C:\EXCEl\BACKUPS\<project>\` (`controllers_server.py:193, 201-239`).

**Writes are not immediate.** All reads/writes go through an in-memory write-behind cache
(`ProjectCache`, `controllers_server.py:70-196`). Patches mutate the cached dict and mark the
project dirty; a background `cache-flush` thread writes dirty projects to disk every
**2 seconds** (`FLUSH_INTERVAL`, `controllers_server.py:77`; flush loop `:159-174`). So the file
on disk is at most ~2 seconds behind what clients see.

### What happens on server stop

- **Graceful stop (Ctrl+C in the console):** the interpreter exits normally and the registered
  `atexit` handler (`controllers_server.py:88`) runs `flush_all()` (`:133-144`), writing every
  remaining dirty project to disk. **No data is lost.**
- **Hard kill** (`taskkill /F`, ending the process in Task Manager, closing the console window
  with the X button, a crash, or power loss): `atexit` handlers are **not guaranteed to run**.
  Any edits from the last ~2 seconds are lost, plus anything stuck in the disk-write retry path —
  `atomic_write_json` (`controllers_server.py:32-57`) retries up to 15 times with backoff when
  antivirus/indexer locks block the file, so a project in that state can stay dirty for longer
  than 2 seconds.
- **File corruption is not a risk either way:** writes are atomic (temp file + `os.replace`),
  so a kill mid-write leaves the previous complete JSON, never a half-written file.

### Recommended restart procedure (no code change required)

1. Stop the server with **Ctrl+C** — never `taskkill /F` or Task Manager "End task",
   and don't close the console window with the X button.
2. Belt-and-suspenders: wait ~3 seconds after the last user activity before stopping, so the
   background flush has already written everything.
3. Verify: check the modified timestamps of the files in `C:\EXCEl\GROUP\` after shutdown —
   they should be at or after the time of the last edit.

### Optional future hardening (when a code change window opens)

- The cache has a proper `shutdown()` method (`controllers_server.py:146-150`) that stops the
  flush thread cleanly and performs a final flush — **but it is never called from anywhere**.
  Wire it to `SIGINT`/`SIGTERM` (and call it after `socketio.run()` returns in
  `flask.server.py`) so that service-manager stops and console closes also flush
  deterministically instead of relying solely on `atexit`.
