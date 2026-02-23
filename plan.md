# Kanban Board (kanban.html) — Implementation Plan

## Overview
Create a new kanban board view (`kanban.html` + `kanban.css` + `kanban.js`) that displays **leaf-node tasks** as draggable cards across three columns based on status. Follows the same architecture as `changerequests.html` (kanban layout) but operates on the **task data** from `task.js`/`task.html`.

---

## Files to Create
1. **kanban.html** — Page structure (top bar, project picker, 3-column board, detail modal)
2. **kanban.css** — Styling (gradient top bar from bground.png, card styles, modal, etc.)
3. **kanban.js** — All logic (data loading, leaf-node extraction, filtering, drag-drop, WebSocket, modal)

## Files to Modify
4. **index.html** — Add a 3rd landing card for "Kanban" (alongside Tasks & Grid)
5. **task.html** — Add "Kanban" nav link in top-bar-right
6. **grid.html** — Add "Kanban" nav link in top-bar-right
7. **changerequests.html** — Add "Kanban" nav link in top-bar-right

---

## Detailed Design

### 1. Page Layout (kanban.html)
- **Top bar**: Same gradient as bground.png / changerequests.html. Logo left, project name center, nav links right (Home, Tasks, Grid, Changes).
- **Project Picker Modal**: Same as task.html — fetches `/api/group-projects`, shows table with project name/last saved/entries, allows creating new projects. Shown on page load.
- **Filter Bar**: Search input + "Show only my assigned tasks" checkbox.
- **Three-Column Kanban Board**:
  - Column 1: **Not Started** (blue header, icon: `fa-circle-dot`)
  - Column 2: **In Progress** (orange header, icon: `fa-spinner`)
  - Column 3: **Done** (gray header, icon: `fa-circle-check`) — with sub-counts: `Completed: X | On-Hold: X | Cancelled: X`
- **Detail Modal**: Full task detail popup (like taskdetail.png)
- **Empty State**: Shown when no cards match filters

### 2. Data Loading & Leaf-Node Extraction
- Load task data via `/api/group-projects/<name>` (same endpoint as task.html)
- Join WebSocket room for the project
- **Leaf-node algorithm**: Recursively walk the task tree. A task is a "leaf" if `subtasks` is empty or undefined. For each leaf, build the **breadcrumb path** by tracking ancestors: `Parent → Subtask1 → Subtask2 → LeafName`.
- Also include parent tasks that have no subtasks (they are leaf nodes themselves).

### 3. Card Filtering & Column Assignment
- **Filter by assignee**: Only show cards where `CURRENT_USER_ID` is in `task.assignedTo[]`.
- **Non-assigned cards**: If `CURRENT_USER_ID` is NOT in the card's assignees, still show the card but **greyed out and non-draggable** (visible but disabled). Super users see all cards as active.
- **Status → Column mapping**:
  - `"Not Started"` → Column 1
  - `"In Progress"` → Column 2
  - `"Completed"`, `"On Hold"`, `"Cancelled"` → Column 3
- **Column defaults on drop**:
  - Drop into Column 1 → status = `"Not Started"`
  - Drop into Column 2 → status = `"In Progress"`
  - Drop into Column 3 → status = `"Completed"` (user can change via dropdown)

### 4. Card Design (Rich Cards)
Each card displays:
- **Breadcrumb title**: `Parent → Sub1 → Sub2 → LeafName` (wraps to next line if long)
- **Status badge**: Columns 1 & 2 show a static badge. Column 3 shows a **dropdown** with options: Completed, On Hold, Cancelled.
- **Assignee avatars**: Colored circles with initials (same palette as task.js)
- **% Complete**: Mini progress bar
- **Due date**: End date shown with calendar icon (if set)
- **Flagged indicator**: Small flag icon if `task.flagged === true`

### 5. Drag & Drop
- Uses HTML5 native drag/drop (same pattern as changerequests.js)
- **Super users**: Can drag ANY card between columns
- **Regular users**: Can only drag cards where they are in `assignedTo[]`
- **Greyed-out cards**: Not draggable regardless
- On drop: auto-update status, send patch via WebSocket, re-render board
- When dragged to Column 3, status defaults to "Completed" but the dropdown allows changing to "On Hold" or "Cancelled"

### 6. Detail Modal (Click to Open)
When a card is clicked, open a modal showing all task attributes (matching taskdetail.png):
- **Task Name** (full breadcrumb path)
- **Start Date** / **End Date** (date pickers)
- **Duration** (auto-calculated, read-only)
- **Status** (dropdown: Not Started, In Progress, Completed, On Hold, Cancelled)
- **% Complete** (number spinner 0-100)
- **Cost** (text input with $ prefix)
- **Predecessor** (dropdown selector from task list)
- **Assigned To** (contact picker, multi-select with avatar chips)
- **Description / Notes** (textarea)
- **Attachments** (file upload area, list with download/remove)
- **Editable by**: Super users OR users in `assignedTo[]`. Others see read-only.
- Changes save immediately via `sendPatch()` with debouncing.

### 7. Permission Logic
- `CURRENT_USER_ID` and `SUPER_USERS` arrays (same values as task.js)
- `isSuperUser()`: returns true if CURRENT_USER_ID is in SUPER_USERS
- **Super users**: Can drag all cards, edit all fields in modal, change status dropdowns
- **Assignees (non-super)**: Can drag their own cards, edit fields on their own tasks
- **Others**: Cards visible but greyed out, modal opens in read-only mode, no dragging

### 8. WebSocket Integration
- Connect to Socket.IO (same server.py backend)
- Join project room on project selection
- **Sending**: On any field change in the modal or status change via drag/dropdown, send a patch:
  ```js
  sendPatch({ op: 'update', taskId: id, field: 'status', value: 'Completed' })
  ```
- **Receiving**: Listen for `'patch'` events. On incoming patch:
  - Apply change to local task data
  - If the changed task is a leaf node visible on the board:
    - **Status change** → move card to correct column (animate removal + insertion)
    - **Delete** → remove card from board
    - **Field update** → if the detail modal for that task is currently open, update the field value and flash with light-yellow background (`remote-flash` animation)
  - If the modal is NOT open for that task, just update the local data silently (the card will reflect changes when next rendered or opened)
  - Use `CLIENT_ID` to ignore own broadcasts

### 9. Real-Time Cross-Page Sync (Requirements #10, #11)
- Patches sent from task.html, grid.html, or kanban.html all go through the same WebSocket room
- **Scenario: UserB changes status on task.html** → kanban.html receives patch → card moves between columns automatically
- **Scenario: UserB deletes a task** → kanban.html receives `deleteTask`/`deleteSubtask` patch → card removed from board
- **Scenario: Both UserA (kanban) and UserB (task.html) have the same task open** → field updates flash with yellow highlight in the kanban modal
- The `handleIncomingPatch()` function will map grid `updateCell` ops to task field names using the same `COL_TO_TASK_FIELD` mapping from task.js

### 10. 3rd Column Header — Breakdown Counts
The "Done" column header will show:
```
Done  [total count badge]
Completed: 3 | On-Hold: 1 | Cancelled: 0
```
Sub-counts displayed as smaller text below the main title.

### 11. Navigation Updates
- **index.html**: Add a 3rd main landing card for "Kanban" with a `fa-columns` icon and purple/indigo accent color (`#5C6BC0` background)
- **task.html**: Add `<a href="kanban.html" class="nav-link"><i class="fa fa-columns"></i> Kanban</a>` to top-bar-right
- **grid.html**: Same nav link addition
- **changerequests.html**: Same nav link addition

---

## Implementation Order
1. Create `kanban.css` (styling, reuse patterns from changerequests.css)
2. Create `kanban.html` (page structure)
3. Create `kanban.js` (all logic)
4. Update navigation in index.html, task.html, grid.html, changerequests.html
