# quotafix.md — Fix instructions for `QuotaExceededError` on localStorage (Edge)

**Audience:** Claude (Opus 4.8) working on *modified* copies of `view.js`, `design.js`,
and `update.js` on the server.
**Origin:** These fixes were implemented and verified on the reference copy of the
project on 2026-07-10.

**IMPORTANT — how to use this document:**
- Do **NOT** use line numbers. The server's files differ from the reference copy.
  Locate every change by **function name**, **localStorage key pattern**, or the
  **code patterns** quoted below.
- Function names may differ on the server. Each fix also describes *how to find the
  code by behavior* if the name doesn't match.
- Apply to **all three files**: `view.js`, `design.js`, `update.js`. The bug is a
  cooperation between them — fixing only one file is not enough.
- Preserve all surrounding behavior exactly. Do not refactor or "improve" adjacent
  code while applying these.

---

## The bug being fixed (symptom)

Some users on Microsoft Edge get, in the DevTools console:

```
Uncaught QuotaExceededError: Failed to execute 'setItem' on 'Storage':
Setting the value of 'task_manager_data_<project>' exceeded the quota
```

Other users on the same browser/network see nothing. Affected users may also find
that `design.html` / `update.html` **fail to finish loading** (the error is thrown
*before* the page's init call — see root cause 4).

## Root causes (four, all confirmed on the reference copy)

1. **Browsers cap localStorage at ~10 MB per origin, total across all keys**, counted
   in UTF-16 (2 bytes per character). This limit is hard-coded in Chromium-based Edge —
   no policy, flag, or setting can raise it.
2. **Three pages all cache full project copies in localStorage.** One snapshot of a
   large project is ~0.9M characters ≈ **1.7 MB of quota**. `design.js` and `update.js`
   each store one blob per project (key `task_manager_data_<project>`). `view.js` is
   worse: its save key **embeds the current date** (`<user>_<project>_<yyyy-mm-dd>`),
   so it files a *new* multi-MB copy **every day** the user opens the page.
3. **Nothing ever reads most of it back or deletes it.** `view.js`'s
   `loadFromLocalStorage()` has **zero callers** — every daily snapshot is dead weight
   forever. The only read-back anywhere is design/update's `loadData()` stale-copy
   fallback when the server is unreachable (behavior the owner explicitly does not
   want). So usage simply accumulates until the 10 MB cabinet is full — which is why
   heavy users hit the error and light users don't.
4. **The failing writes in design.js/update.js are unguarded.** `view.js` wraps its
   save in try/catch (fails silently); design/update do not. Worse, in the two
   project-load AJAX handlers the `localStorage.setItem(...)` cache-write runs
   **before** the init call (`initAfterLoad()` in design, `postLoadTransition()` in
   update) — when it throws, **page initialization is skipped entirely**. And
   `saveData()` is called from dozens of edit handlers, so mid-edit throws abort
   whatever code follows.

## The fix strategy (agreed with the owner)

Stop using localStorage as a second database entirely. The Flask server's JSON is the
single source of truth; edits already persist via `sendPatch`. Remove the project-blob
writes, remove the stale-copy fallback (replace with an honest error message), clean up
the junk already sitting in users' browsers, and guard the small legitimate keys that
remain (contacts, kanban card order — those are a few KB, still read back, and must be
**kept**).

---

## Fix 1 — view.js: remove the dead per-day snapshot entirely

### Where to find it

- Function `saveToLocalStorage()` — calls `collectState()` and
  `localStorage.setItem(getSaveKey(), ...)`.
- Function `loadFromLocalStorage()` — reads the same key. **Verify first** that it has
  no callers on the server copy (search for `loadFromLocalStorage(`); on the reference
  copy it has none. If the server copy *does* call it somewhere, stop and reassess that
  call site before deleting.
- `getSaveKey()` — returns `CURRENT_USER_ID + '_' + PROJ_NAME + '_' + currentDate`.

### What to change

1. Delete **every call** to `saveToLocalStorage()`. On the reference copy the callers
   were: `saveAdminCell()` (first line after the `PROJ_NAME` guard), and the
   `undo()` / `redo()` functions (the "Save without pushing to undo stack" spot —
   keep the adjacent `saveToServer()` call). If broadcastfix.md was applied earlier,
   the calls inside `handleIncomingGridPatch` are already gone.
2. Delete the `saveToLocalStorage()` and `loadFromLocalStorage()` **function
   definitions**. Keep `getSaveKey()` only if something else uses it (on the reference
   copy nothing else did, but it was kept for the comment trail — either is fine).
3. Do **NOT** touch the contacts functions (`loadWsContacts` / `saveWsContacts`,
   key `task_manager_contacts`) except as described in Fix 4.

---

## Fix 2 — design.js and update.js: stop caching, drop the stale fallback

### Where to find it

In **each** of the two files:

- `saveData()` — two-liner that does
  `localStorage.setItem(getStorageKey(), JSON.stringify({tasks, taskIdCounter}))`.
  It has ~30+ callers; do not touch the callers.
- `loadData()` — reads the same key back into `tasks` / `taskIdCounter`.
- `openGroupProject(name)` and the default-project loader (`loadDefaultGroupProject()`)
  — AJAX calls to `/api/load-group` whose success handlers contain an inline
  `localStorage.setItem(getStorageKey(), ...)` cache-write, and whose failure paths
  call `loadData()` as a fallback.

### What to change

1. **Make `saveData()` an empty no-op** (keep the function so its many callers stay
   valid). Put a comment in the body explaining why — see the reference wording:

```javascript
function saveData() {
    // Intentionally a no-op. This used to cache the full task tree in
    // localStorage ('task_manager_data_<project>') on every edit. The
    // blob is multi-MB on large projects; combined with other pages'
    // caches it exceeded the browser's ~10MB per-origin quota and the
    // unguarded setItem threw an uncaught QuotaExceededError (breaking
    // page init and edit handlers). The server JSON is the single source
    // of truth — edits are persisted via sendPatch, not this cache.
    // The stale-copy fallback (loadData) was removed along with it.
}
```

2. **Delete the `loadData()` function definition** and replace its call sites:

   In `openGroupProject(name)`'s AJAX handlers (design.js calls `initAfterLoad()`
   after loading; update.js calls `postLoadTransition()` — adapt the name):

```javascript
success: function (resp) {
    if (resp && resp.ok && resp.data && resp.data._taskData) {
        tasks = resp.data._taskData.tasks || [];
        taskIdCounter = resp.data._taskData.taskIdCounter || 0;
    } else {
        // No stale localStorage fallback: the server is the
        // single source of truth. Tell the user instead of
        // silently showing an outdated copy.
        tasks = [];
        taskIdCounter = 0;
        alert('The project "' + name + '" could not be loaded from the server.');
    }
    initAfterLoad();   // update.js: postLoadTransition();
},
error: function () {
    tasks = [];
    taskIdCounter = 0;
    alert('The project "' + name + '" could not be loaded. Please check that the server is running.');
    initAfterLoad();   // update.js: postLoadTransition();
}
```

   In the default-project loader, replace the inner `loadData();` fallback (the
   "resp.ok but no `_taskData`" branch) with `tasks = []; taskIdCounter = 0;`. Keep
   the existing "project was not found" / "could not be loaded" alerts as they are.

3. **Delete the inline `localStorage.setItem(getStorageKey(), ...)` cache-writes** in
   both loaders. This is the exact statement that threw the reported error.
   **Critical check:** the init call (`initAfterLoad()` / `postLoadTransition()`) must
   still run in every branch it ran in before — the setItem you are deleting sat
   *above* it.

4. `getStorageKey()` and the `STORAGE_KEY` variable become unused — delete them
   (verify with a search first). **Do NOT delete** `CONTACTS_STORAGE_KEY` or, in
   update.js, `getCardOrderKey()` / `loadCardOrder()` / `saveCardOrder()`.

---

## Fix 3 — all three files: one-time cleanup of the junk already stored

Affected users already have full cabinets; removing the writes doesn't empty them.
Add this self-executing cleanup in the persistence section of **each** of the three
files (it runs once per page load; after the first run there is nothing left to
remove):

```javascript
// One-time cleanup of legacy localStorage caches. Older builds stored a
// full copy of the project per page ('task_manager_data_<project>') and
// per DAY ('<user>_<project>_<yyyy-mm-dd>', written by view.html) that
// nothing reads back anymore. Small, still-used keys
// (task_manager_contacts, kanban_card_order_*) do not match these
// patterns and are kept.
(function cleanupLegacyStorageCaches() {
    try {
        var doomed = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (/^task_manager_data_/.test(k) || /_\d{4}-\d{2}-\d{2}$/.test(k)) {
                doomed.push(k);
            }
        }
        for (var j = 0; j < doomed.length; j++) {
            localStorage.removeItem(doomed[j]);
        }
        if (doomed.length) {
            console.info('Removed ' + doomed.length + ' legacy localStorage cache key(s).');
        }
    } catch (e) { /* storage unavailable — nothing to clean */ }
})();
```

**Pattern safety check (do this on the server copy):** the two regexes must match the
junk keys and nothing else. `task_manager_contacts` does not match
`^task_manager_data_`. The kanban card-order key ends with the user ID, not a date.
If the server copy stores any *other* keys, list all key names first (see
Verification) and confirm none of the keepers ends in `_YYYY-MM-DD` or starts with
`task_manager_data_`.

---

## Fix 4 — guard the remaining small writes

Any `localStorage.setItem` left after Fixes 1–3 (contacts in all three files; card
order in update.js may already be guarded) must be wrapped so a storage failure can
never throw into an edit handler:

```javascript
function saveContacts() {
    // Guarded: a quota failure on this small, legitimate key must never
    // throw an uncaught error into the calling edit handler.
    try {
        localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    } catch (e) {
        console.warn('Contacts save to localStorage failed:', e);
    }
}
```

(view.js's equivalent is `saveWsContacts()` with the `wsContacts` variable.)

Final sweep: search each file for `localStorage.setItem` — every remaining occurrence
must be inside a `try { ... } catch`.

---

## What NOT to change (tempting but wrong)

- Do **not** delete `saveData()`'s many call sites — emptying the function body is the
  whole fix; touching dozens of handlers invites regressions.
- Do **not** remove the contacts storage (`task_manager_contacts`) or update.js's
  kanban card-order storage — both are small and genuinely read back.
- Do **not** raise or work around the quota (there is no way to in Edge) and do not
  move the project cache to IndexedDB — the decision is to have **no** client-side
  project cache at all.
- Do **not** change the server persistence path (`sendPatch`, `/api/patch-task`,
  `/api/load-group`) — it is untouched by this fix and already the real save
  mechanism.

## Expected results

| Scenario | Before | After |
|---|---|---|
| Heavy user opens design.html | Uncaught QuotaExceededError, init skipped | Loads normally; legacy keys auto-deleted on first load |
| Daily view.html use | +1.7 MB dead key per day, forever | No project blobs written at all |
| Server unreachable at load | Silently shows a stale cached copy | Clear alert; empty page instead of stale data |
| Contacts / card order | Work | Unchanged (still stored, now guarded) |

## Verification (run in DevTools console on any of the three pages)

**Before applying**, capture the current state on an affected machine:

```javascript
var total = 0, rows = [];
for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i), v = localStorage.getItem(k);
    total += k.length + v.length;
    rows.push({ key: k, quotaMB: +((k.length + v.length) * 2 / 1048576).toFixed(2) });
}
rows.sort(function (a, b) { return b.quotaMB - a.quotaMB; });
console.table(rows);
console.log('used ~' + (total * 2 / 1048576).toFixed(2) + ' MB of 10 MB');
```

**After applying**, on the same machine:

1. Load each page once; the console should log
   `Removed N legacy localStorage cache key(s).` on the first load only.
2. Re-run the snippet above: no `task_manager_data_*` keys, no date-suffixed keys;
   total usage should be a fraction of a MB (contacts + card order only).
3. **Regression — persistence:** edit a task in design.html, reload the page — the
   edit must still be there (it comes from the server, not localStorage).
4. **Regression — contacts:** add/edit a contact, reload — must persist.
5. **Regression — kanban order:** reorder cards in update.html, reload — must persist.
6. **Server-down behavior:** stop Flask, load design.html and pick a project — expect
   the "could not be loaded. Please check that the server is running." alert and an
   empty (but functional) page, **not** a stale copy and **not** a broken page.
7. No `Uncaught QuotaExceededError` anywhere; the only storage messages allowed are
   the `console.warn` fallbacks from the guarded small writes (and only if storage is
   genuinely unavailable).
