<!--
================================================================================
INSTALL ON ANOTHER MACHINE
================================================================================
This is a portable copy of the "midnight-terminal" Claude skill.

To use it with Claude Code on another machine, save the section below
(everything from the "---" frontmatter onward) as:

    ~/.claude/skills/midnight-terminal/SKILL.md

  - macOS/Linux:  ~/.claude/skills/midnight-terminal/SKILL.md
  - Windows:      C:\Users\<you>\.claude\skills\midnight-terminal\SKILL.md

Create the "midnight-terminal" folder if it doesn't exist. Restart Claude Code
(or start a new session) and the skill will be available. Invoke it by asking
for a page "in the midnight-terminal style", or type /midnight-terminal.

Note: strip this HTML comment block if you want a clean SKILL.md — only the
frontmatter + body below is required.
================================================================================
-->

---
name: midnight-terminal
description: Build a single-page HTML site in the "midnight terminal" editorial style — dark trading-desk aesthetic with Bricolage Grotesque + IBM Plex Mono, amber/teal/red accents on near-black, chart-paper grid background with grain, numbered chapter sections, and interactive canvas panels. Use when the user asks for a webpage "in the midnight-terminal style" or "like the price-action playbook page".
---

# Midnight Terminal — page design system

Recreate this exact aesthetic. Do NOT invent a new one. The reference implementation
(if it still exists) is `C:\PROJECTS\STOCK_MA_CHART\price_action_playbook.html`.

## Hard requirements

- One self-contained `.html` file: inline CSS + vanilla JS, no frameworks, no build step.
- Only external requests allowed: Google Fonts (with sensible fallbacks).
- Dark theme only. Works at Windows display scaling 100–200% (see Canvas rules).

## Fonts

```
https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap
```
- Display/headers: `'Bricolage Grotesque',sans-serif` — weight 700–800, tight letter-spacing (−.01 to −.02em).
- Everything else (body, UI, data, labels): `'IBM Plex Mono',ui-monospace,Menlo,monospace`, 14.5px base, line-height 1.65.
- Keep mono body paragraphs short; the mono look is the point but walls of mono text are unreadable.

## Palette (use these exact CSS variables)

```css
:root{
  --bg:#07090e; --panel:#0d121b; --panel2:#121926; --line:#1c2534; --line2:#28324a;
  --ink:#e2e9f4; --dim:#8b96a8; --faint:#525e75;
  --up:#31d69f; --down:#ff5e6e; --amber:#ffb648; --vwap:#6fa8ff;
  --up-soft:rgba(49,214,159,.12); --down-soft:rgba(255,94,110,.12);
  --radius:10px;
}
```
Amber is THE accent: chapter numbers, kickers, highlights, primary buttons, sliders, key lines.
Green/red only for semantic good/bad (gains/losses, correct/incorrect). Blue (`--vwap`) sparingly for a secondary data series.
`::selection{background:var(--amber); color:#100c04}`.

## Atmosphere (body pseudo-elements)

- `body::before` (fixed, z-0): two faint radial glows (amber top-right, blue left) PLUS a
  44px chart-paper grid via two `linear-gradient` lines at `rgba(160,190,255,.028)`.
- `body::after` (fixed, z-1, opacity .05): SVG `feTurbulence` fractal-noise grain as a data-URI.
- All content wrappers get `position:relative; z-index:2`.

## Signature structural elements (include what fits, in this spirit)

1. **Ticker tape** at very top: thin strip, 12px mono, key phrases separated by `·`,
   amber `<b>` highlights, CSS `@keyframes` marquee (translateX 0 → −50%, content repeated 4×, ~46s linear).
   Disable under `prefers-reduced-motion`.
2. **Sticky nav**: `rgba(7,9,14,.82)` + `backdrop-filter:blur(10px)`, brand left ("WORD <span amber>WORD</span>"),
   numbered anchor links right (`01 Name`, `02 Name`…).
3. **Hero**: uppercase amber kicker with .28em letter-spacing → huge Bricolage headline
   (clamp(44px,7.4vw,84px), line-height .98) with one amber word and one `--faint` word →
   dim mono lede → optional amber-left-border blockquote → row of stat chips
   (bordered panels: big Bricolage number + tiny uppercase label).
4. **Chapter headers**: `01` in amber mono + Bricolage h2 + right-aligned faint uppercase tag,
   baseline-aligned flex row with bottom border.
5. **Panels**: `--panel` bg, `--line` 1px border, 10px radius; header row (title + faint sub + legend chips),
   content, footer controls row separated by borders.
6. **Cards** in a 3-col grid: 2px amber gradient top rule, small inline SVG glyph, title with
   amber `<span>` suffix, dim 12.5px body. Hover: translateY(-2px).
7. **Numbered steps**: CSS counter rendered as big outlined numerals
   (`color:transparent; -webkit-text-stroke:1px var(--amber)`).
8. **Warning callout**: `--down` border + `--down-soft` background.
9. **Footer**: faint 11.5px mono disclaimer.

## Controls

- Buttons: mono 12px, `--panel2` bg, `--line2` border, 7px radius; hover → amber border+text.
  `.primary` = solid amber with near-black text. Semantic `.long`/`.short` variants use green/red borders.
- Range sliders: 4px `--line2` track, 18px amber thumb with dark border ring.
- Checkboxes: `accent-color:var(--amber)`.

## Canvas charts (only if the page needs data viz)

- Hand-rolled 2D canvas, no chart libs. Candles/bars in `--up`/`--down`; overlay lines amber first, blue second.
- Grid lines `rgba(160,190,255,.055)`, axis labels 10px mono in `--faint`.
- Crosshair on hover + dark pill readout. Annotation vocabulary: amber-circled badge markers with
  dotted leader lines, translucent green/red zone rectangles, dashed reference lines.

### Non-negotiable correctness rules (bugs found the hard way)

1. **Capture the design height ONCE** (`this.designH=+canvas.getAttribute('height')` in the constructor).
   NEVER re-read the height attribute inside the draw loop — setting `canvas.height=h*dpr` overwrites
   that attribute, and re-reading it compounds by `dpr` every frame → infinite page growth at 125%/150% Windows scaling.
2. Round bitmap sizes: `Math.round(w*dpr)`; only reassign width/height when changed.
3. Any grid track containing a canvas: `minmax(0,1fr)`, never bare `1fr`; canvas gets
   `display:block; width:100%; max-width:100%` and its wrapper `min-width:0`.
4. Redraw via one `ResizeObserver` per canvas; `ctx.setTransform(dpr,0,0,dpr,0,0)` before drawing.

## Voice

Copy is confident, compact, second-person, slightly wry ("Skipping garbage IS the edge").
Bold key phrases in `--ink`; amber `<span class="hl">` for the single most important idea per paragraph.
Explanations in prose, not bullet spam.
