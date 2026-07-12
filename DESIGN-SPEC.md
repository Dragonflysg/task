# Service Desk Dashboard — Design Specification ("Flow Board")

A design spec for restyling the existing Service Desk ticket dashboard. It describes the
target look and behavior completely, so it can be applied to the current codebase without
seeing the mockup. A reference implementation exists as a single self-contained HTML file
(`03-light-kanban.html`) — if it is available alongside this document, treat it as the
source of truth for pixel details.

**Aesthetic in one line:** light enterprise ITSM — IBM Plex typography, cool blue-gray
surfaces, one saturated blue accent, flat tinted chips, no gradients on content surfaces,
generous card padding, subtle borders and shadows.

---

## 1. Design tokens

Define these as CSS custom properties on `:root` and use them everywhere; do not hard-code
colors in components.

```css
:root{
  /* Surfaces */
  --bg:        #eef2f8;   /* page background (cool blue-gray) */
  --surface:   #ffffff;   /* cards, toolbar, table */
  --lane-bg:   #e6ebf4;   /* kanban lane wells (slightly darker than page) */
  --border:    #dde4ee;   /* default 1px borders */

  /* Ink (text) scale */
  --ink:       #161f2e;   /* primary text */
  --ink-2:     #4b5a72;   /* secondary text */
  --ink-3:     #8593a9;   /* muted text: ages, meta, table headers */

  /* Brand */
  --brand:     #0f4dbc;   /* logo, ticket numbers, active view-switcher text */
  --brand-2:   #1668e3;   /* primary buttons */

  /* Status accents (lane markers) */
  --open:      #1668e3;   /* blue   */
  --wip:       #0e7490;   /* teal   */
  --pending:   #b45309;   /* amber  */
  --closed:    #15803d;   /* green  */
}
```

The only gradient in the whole design is the small logo square:
`linear-gradient(135deg, #0f4dbc, #3b82f6)`. Content surfaces are flat.

## 2. Typography

- **UI font:** IBM Plex Sans (weights 400 / 500 / 600 / 700)
- **Code font:** IBM Plex Mono (400 / 500 / 600) — used for **ticket numbers and all
  6-character IDs** (customer, agent). This is a deliberate signature of the design:
  identifiers are always monospaced.
- Load from Google Fonts or self-host:
  `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap`

| Element | Size | Weight | Color | Notes |
|---|---|---|---|---|
| Card description | 15.5px | 500 | `--ink` | line-height 1.5; reserve `min-height:2.9em` (2 lines) so cards align |
| Ticket number | 13px | 600 | `--brand` | IBM Plex Mono |
| Customer ID | 12.5px | 600 | `--ink-2` | IBM Plex Mono |
| Age ("25m", "4h") | 12px | 400 | `--ink-3` | right-aligned in card top row |
| Status pill | 11px | 700 | see §5 | uppercase, letter-spacing .6px |
| Classification tag | 11.5px | 600 | see §6 | uppercase, letter-spacing .5px |
| Lane title | 15px | 700 | `--ink` | |
| Lane sub-note | 12px | 400 | `--ink-3` | e.g. "incl. pending customer" |
| Lane count badge | 12.5px | 600 | `--ink-2` | |
| Toolbar logo text | 16px | 700 | `--ink` | |
| Toolbar meta | 13px | 400 | `--ink-3` | |
| Table cells | 14px | 400 | `--ink` | headers 11.5px / 600 / uppercase / `--ink-3` |

## 3. Status model

There are **three workflow groups** but **five display statuses**:

| Group (lane) | Statuses in it | Lane accent |
|---|---|---|
| **Open** | `Open` | `--open` (blue) |
| **Work In Progress** | `Work In Progress`, `Pending` | `--wip` (teal) |
| **Closed** | `Closed`, `Awaiting Closure` | `--closed` (green) |

Rules:

1. **On the Board view**, the lane communicates the primary status, so cards show a status
   pill **only** when their exact status is the secondary one of the lane (`Pending` or
   `Awaiting Closure`).
2. **On Cards and List views** (no lane context), **every** ticket shows its status pill.
3. Fully `Closed` tickets render at `opacity:.82` (cards) / `opacity:.75` (table rows).
   `Awaiting Closure` stays at full opacity — it still needs action.
4. Status is never communicated by color alone — the pill always contains the status text.

## 4. Page layout

```
┌────────────────────────────────────────────────────────────────┐
│ TOOLBAR (sticky, white, 64px, bottom border)                   │
│  [logo] Meridian ITSM / Service Desk   [Cards|Board|List]      │
│                              meta text        [+ New ticket]   │
├────────────────────────────────────────────────────────────────┤
│ ACTIVE VIEW  (max-width 1420px, centered, padding 28px)        │
│                                                                │
│  Board:  3 lanes  grid-template-columns:repeat(3,minmax(340px,1fr)); gap:22px │
│  Cards:  grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:16px  │
│  List:   full-width table                                      │
└────────────────────────────────────────────────────────────────┘
```

- Toolbar: `position:sticky; top:0`, background `--surface`, `border-bottom:1px solid --border`.
- Board collapses to a single column below **1020px**.
- Lanes use `align-items:start` on the grid so their heights are independent.

## 5. Components

### 5.1 View switcher (Cards / Board / List)

Segmented control in the toolbar. Track: `--bg` background, radius 8px, 3px padding.
Buttons: 13.5px / 600, padding 7px 16px, radius 6px, color `--ink-3`, transparent.
Active button: background `--surface`, color `--brand`, shadow `0 1px 3px rgba(20,40,80,.12)`.

Behavior: one ticket data source, three renderers. Clicking a segment toggles which view
container is visible (`display:none` ↔ grid/block) and moves the active style. All three
views render from the same ticket list so they never disagree.

### 5.2 Kanban lane

- Well: background `--lane-bg`, radius 14px, padding 12px.
- Header row: colored **square** (11×11px, radius 3px) in the lane's status accent →
  lane title (15px/700) → muted sub-note → count badge pushed right
  (pill, background `#d7dfec`, padding 3px 11px).
- Cards stack with 12px gap.

### 5.3 Ticket card

Structure (top → bottom):

```
[TCK-10482]  [status pill — per rules §3]            [25m]
Description text, up to two lines, 15.5px/500
──────────────────────────────────────────────────────
[CLASSIFICATION TAG]              [CUSTID] → [avatar]
```

- Container: `--surface`, `1px solid --border`, radius 12px, padding `18px 18px 15px`,
  shadow `0 1px 2px rgba(22,38,66,.06)`, `cursor:grab` (cards are drag targets on the board).
- Hover: border `#b9c8e0`, shadow `0 6px 16px -6px rgba(22,38,66,.18)`, transition .15s.
- Footer left: classification tag. Footer right ("flow"): customer ID in mono,
  a muted arrow `→` (`#a9b8cf`), then the **assignee avatar** (§5.6).

### 5.4 Status pills

Rounded-full chips, 11px/700 uppercase, padding 3px 10px, with a 6px dot (`currentColor`)
before the text.

| Status | Background | Text | Variant |
|---|---|---|---|
| Open | `#e3edff` | `#1345a8` | solid |
| Work In Progress | `#dff4f8` | `#0d6480` | solid |
| Pending | `#fdf0dd` | `#92510a` | solid |
| Closed | `#e2f3e8` | `#116a37` | solid |
| Awaiting Closure | `#ffffff` | `#116a37` | **hollow**: white bg + `1px solid #a5d6b7` |

The hollow treatment distinguishes "resolved but awaiting confirmation" from a hard close.

### 5.5 Classification tags

Small rectangles (radius 6px, padding 4px 10px), 11.5px/600 uppercase, flat tints:

| Classification | Background | Text |
|---|---|---|
| Hardware | `#e3edff` | `#1345a8` |
| Software | `#e1f3fa` | `#0d6480` |
| Network  | `#e7e9fd` | `#4338ca` |
| Access   | `#dff0fb` | `#0c4a6e` |
| Other    | `#eaeef4` | `#526175` |

All tints stay in the blue family (Other is neutral gray-blue); the classification label is
always text, never icon- or color-only.

### 5.6 Assignee avatar (and unassigned state)

- **Assigned:** round `<img>`, 32px in cards, 26px in the table. `object-fit:cover`,
  `border:2px solid #fff`, ring `box-shadow:0 0 0 1.5px var(--border)`.
  `src` comes from the avatar API: `…/avatar/{AGENT_ID}.jpg`.
  Always set `alt="Agent {AGENT_ID}"` and `title="Agent {AGENT_ID}"` so the ID remains
  discoverable on hover and to screen readers.
- **Unassigned** (all `Open` tickets, and any `Work In Progress` ticket without an agent):
  same-size circle, `1.5px dashed #aebcd1` border, background `#f3f6fb`, containing a gray
  person-outline icon (`#9aa9c0`), `title="Unassigned"`. In the List view use the italic
  text label "Unassigned" (12px, `--ink-3`) instead of the circle.

### 5.7 List view table

- White table, `1px solid --border`, radius 12px, `overflow:hidden`; wrap in a
  horizontally scrollable container for narrow screens.
- Header row: background `#f7f9fc`, bottom border `--border`.
- Cells: padding 13px 16px, row separators `#edf1f8`, row hover `#f4f8ff`.
- Columns: Ticket (mono, brand color) · Description · Classification (tag) ·
  Status (pill) · Customer (mono) · Assignee (26px avatar / "Unassigned") · Age (muted).

### 5.8 Toolbar primary button

"+ New ticket": background `--brand-2`, white, 14px/600, padding 9px 18px, radius 8px.

## 6. Data model

Each ticket card requires exactly these fields:

```json
{
  "id": "TCK-10482",
  "description": "Laptop won't power on after Windows 11 update — no charge LED.",
  "classification": "hardware | software | network | access | other",
  "status": "open | wip | pending | closed | await",
  "customerId": "A7X24K",
  "agentId": "J3M9Q1 | null",
  "age": "25m"
}
```

- Customer and agent IDs are 6-character alphanumeric codes, always rendered in
  IBM Plex Mono.
- `agentId` is `null` when unassigned → render the dashed-circle state (§5.6).
- Lane assignment on the Board is derived from `status`
  (`open→Open`, `wip|pending→Work In Progress`, `closed|await→Closed`).

## 7. Interaction & behavior summary

- **View switching:** three containers, one visible; renderers share one data source.
- **Card hover:** border + shadow lift (see §5.3). Table row hover: `#f4f8ff`.
- **Tooltips:** customer ID → "Customer {ID}"; avatar → "Agent {ID}"; dashed circle →
  "Unassigned".
- **Responsive:** board lanes stack to one column < 1020px; cards grid is
  `auto-fill/minmax(340px,1fr)`; table scrolls horizontally rather than squashing.
- Transitions are subtle and fast (.15s ease); no entrance animations in this concept.

## 8. Accessibility requirements

1. Status and classification always carry visible text — color is reinforcement only.
2. Avatars have `alt` text containing the agent ID.
3. Muted text (`--ink-3`) is reserved for non-essential metadata (ages, sub-notes).
4. Interactive elements (view switcher, buttons) are real `<button>` elements.
5. Body text sits at ≥ 15.5px on cards for readability at a glance — this dashboard is
   read across the room on service desk screens; do not shrink it below this.

## 9. Applying this to the existing dashboard

Suggested order of work when revising the current site:

1. Introduce the token block (§1) and the two IBM Plex font families; map existing
   hard-coded colors onto the nearest token.
2. Restyle the existing ticket card to the anatomy in §5.3 (top row / description /
   divider-less footer), including the mono treatment for ticket numbers and IDs.
3. Replace the current status rendering with the pill component (§5.4) and the
   three-lane grouping rules (§3) — note the lane/pill split: pills appear on Board
   cards only for `Pending` and `Awaiting Closure`.
4. Swap assignee ID text for the avatar component (§5.6), wiring `src` to the avatar
   API and keeping the ID in `alt`/`title`. Implement the unassigned dashed state.
5. Add the view switcher last; Cards and List reuse the same card/pill/tag components,
   so they are cheap once the Board looks right.

Keep whatever framework, routing, and data-fetching the production dashboard already
uses — this spec only changes markup structure, styling, and the small view-switching
behavior.
