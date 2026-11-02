# Unslop: the audit, the direction, the passes

This is the record of the redesign of Abacus's interface in
[issue #11](https://github.com/ferraridavide/abacus/issues/11): the screen was audited for the tells of
AI-generated UI with the [unslop](https://github.com/heydamir/unslop) skill, given a direction, then fixed in
the skill's nine ordered passes and made square everywhere.

The skill lives in `.claude/skills/unslop/` (git-ignored, copy it in with the commands below). Every decision on
this page is meant to survive the next redesign: if a change here is reverted, the audit says why it was made.

```bash
git clone https://github.com/heydamir/unslop
mkdir -p .claude/skills && cp -r unslop/skills/unslop .claude/skills/
# then, in an agent that reads SKILL.md: /unslop web/src
```

**Credit.** unslop was created by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)) and is licensed
CC BY 4.0. The credit stays in this file, in this repository.

---

## The audit

The screen is the app shell: sidebar, toolbar, grid, inspector, plus the viewer, the moodboard, the dialogs,
the demo landing page and the Chrome extension surfaces. Signs found, one line each, with where they lived:

| # | Sign | Where |
|---|------|-------|
| 1 | Blue-to-violet accent pair, `#5b8cff` next to `#8b5cff` | `--accent`, `--accent-2` in `:root` (`web/src/styles.css`) |
| 2 | Accent pair mixed in `linear-gradient(135deg, …)` fills | avatar fallback, empty-state art, bookmarklet, semantic-search icon, import progress, semantic progress bar |
| 3 | Coloured glow: `--accent-glow` used as a `box-shadow` | import progress bar (`styles.css`) |
| 4 | Coloured drop shadows on buttons and cards | `.btn.primary`, `.bookmarklet`, `.empty-art`, `.semantic-icon`, `.card:hover .thumb`, `.card.selected .thumb`, `.landing-frame` |
| 5 | A blue-to-violet radial wash behind content | semantic-search hero panel, demo landing background |
| 6 | Gradient text | demo landing `h1` (`linear-gradient(180deg, #fff, #a1a3ab)` + `background-clip: text`) |
| 7 | Rounded everything: 117 `border-radius` declarations in `styles.css` alone | 30 of them 12px or more, 11 at `50%`, the rest 2–10px |
| 8 | Circles as a default | status dots, avatars, radio buttons, hue-picker handle, selection ticks, viewer arrows, switches, scrollbar thumbs, video play plate |
| 9 | A type scale made of one-offs | 15 sizes and five weights in one stylesheet, no scale, no tabular figures |
| 10 | One-off type instead of a scale | 15 distinct sizes (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18, 20, 22) and five weights (500, 550, 600, 650, 700) |
| 11 | Uppercase labels with wide tracking | `Folders`, `Tags`, `Shortcuts`, menu labels, inspector section titles, `Settings`, the demo badge |
| 12 | Emoji as the logo | `🧮` in the app, the favicon, the extension pages and icons, the quick-add page. It renders as a hollow box wherever the system has no emoji font, which is most Linux desktops |
| 13 | Decorative motion | hover scales on swatches, colour dots, stars and the viewer arrows, a lift-and-shadow on subfolder cards, a thumbnail zoom on hover, an infinitely bobbing chevron on the landing page |
| 14 | Odd spacing steps that break the rhythm | 3, 5, 7, 9, 11 and 13px in gaps, paddings and margins |
| 15 | Counts as glowing pills | the item count in the toolbar was a filled pill |

Heavy slop: signs across colour, shape, type, motion and even the logo. The full process ran; there was no
polish-only mode.

## The direction

- **Product.** A self-hosted visual library for people who collect references: images, GIFs, videos and saved
  posts, filed into folders and pinned onto moodboards.
- **Character.** Exact, quiet, a little archival.
- **World.** The contact sheet and the darkroom. Matte graphite surfaces, a safelight amber, film-edge
  annotations printed under every frame.
- **Moments.** The thumbnails themselves: the work carries all the colour here, so the chrome stays grey and the
  pictures are the only rich thing on screen. The second moment is the moodboard, where images float on a dark
  field with a faint dot grid.
- **Signature.** The mono frame annotation under each thumbnail (`500×250 · JPG`), the way a contact sheet
  numbers and captions its frames, and the squared beads of the logo mark.

The tells in the audit are the opposite of this direction: a blue-violet glow is a screen, not a darkroom; a
radius is a softness, and the tools people keep their references in — Eagle, PureRef, Figma panels — are
rectangular.

## Colour: one accent, used rarely

| Token | Value | Role |
|-------|-------|------|
| `--bg` | `#111110` | the page |
| `--panel` / `--panel-2` / `--panel-3` | `#171716` / `#1d1d1b` / `#262624` | surface steps; depth comes from these and from hairlines |
| `--border` / `--border-strong` | `#ece9e3` at 8% / 14% | hairlines |
| `--text` / `--text-dim` / `--text-faint` | `#ece9e3` / `#a5a19a` / `#74706a` | three text roles, no more |
| `--accent` | `#e8a33d` | selection, the active row, focus, the one figure that matters, the brand mark |
| `--accent-ink` | `#14120d` | ink on the accent and on light plates |
| `--danger` / `--ok` | `#e2594a` / `#4fbf8f` | meaning only |

The ramp is a warm graphite, a touch toward the darkroom's safelight; it still reads as grey, which is what an
app people stare at for hours needs. The accent is not the button: the primary action is an off-white plate with
dark ink, which leaves amber free to mean *this one* — the selected frame, the active setting, the focus ring.
Contrast: `#e8a33d` on `#111110` is about 8.7:1, and `#14120d` on `#e8a33d` about 9:1, so both directions pass
4.5:1.

## Square: radius 0, everywhere

`--radius: 0` and every `border-radius` in `web/src/styles.css`, `web/src/demo.css` and
`extensions/chrome/*.css` is `0`. The skill's Details pass prescribes nested radii of 8–20px; that pass is
**overridden on purpose** here — the rule for this product is radius 0, full stop, because square corners are
what professional visual tools look like. Division of labour instead of radii:

- **Edges** are 1px hairlines (`--border`, `--border-strong`) and surface steps (`--panel-2`, `--panel-3`).
- **Selection** is a 2px amber frame drawn with `outline` + `outline-offset: -2px` over the thumbnail, plus a
  20px amber square tick.
- **Circles** became squares: status dots, avatars, radio buttons (the inner square is what fills), the
  hue-picker handle, the selection tick, the viewer arrows, the switch track and knob, the scrollbar thumb, and
  the video play plate in the viewer chrome.
- **Focus** is a 1px square ring in the accent, not a soft halo.

The scrollbar thumb keeps a 3px transparent border with `background-clip: content-box` so the bar stays 4px
wide; that is a width trick, not a round corner.

Radius now comes from a token scale (`--r-xs` 4, `--r-sm` 6, `--r-md` 8, `--r-lg` 10, `--r-xl` 12, `--r-2xl` 18,
`--r-pill`, `--r-circle`), so the square design is the default rather than the only choice: see
[Theming](#theming). Every rule names a token, and no rule carries a literal radius.

## Type: one grotesk, one mono

Type sizes are the scale **11 / 12 / 13 / 15 / 18 / 22**, with two weights, 400 and 500, and 600 only for rare
emphasis. Hierarchy comes from size and colour. `16px` survives in exactly one place — form fields on phones,
where anything smaller makes iOS Safari zoom the page on focus — and that is documented here rather than
removed.

- Interface: the project's existing stack, led by Inter. It is not loaded as a webfont — Abacus is self-hosted and
  often runs offline, so the stack falls back to the system grotesk where Inter is absent. That is the one
  type decision that pairs with the app's deployment story instead of against it.
- Metadata: `--font-mono` for the frame annotation under each thumbnail, counts, shortcuts, dimensions and
  version strings, so figures line up in one column.
- Labels are sentence case: `Folders`, `Tags`, `Shortcuts`, `Settings`, `Type`, `Sort by`. No uppercase, no wide
  tracking.
- No italic, no negative tracking on small text, no gradient text.

## The nine passes

### 1. Spacing

- Everything off the 4px rhythm was collapsed onto it: odd values (3, 5, 7, 9, 11, 13px) became 4, 8, 12, 16;
  even 2px steps stay for nudges inside small controls. 63 declarations moved.
- Navigation is the densest part: sidebar rows 30 → 32px, menu rows 30 → 32px, section heads 26 → 28px, small
  icon buttons 22 → 24px. Icons keep one 18px column so labels start on one line.
- Cards, captions and the inspector share one padding rhythm (8/12/16); page edges stay 20–24px.

### 2. Colour

- One accent, `#e8a33d`. `--accent-2` and `--accent-glow` are deleted from the tokens, so they cannot come back
  by accident.
- Every accent-pair gradient became a flat fill: avatar fallback and the semantic-search icon are solid accent,
  the import and semantic progress bars are solid accent, the primary button is an off-white plate, the
  bookmarklet is a plain accent plate with dark ink.
- The radial washes behind the semantic-search hero and the demo landing are gone; both are flat surfaces.
- Coloured glows and coloured shadows are gone. Shadows remain only as a neutral float for real windows
  (menus, modals, toasts, the moodboard's items) and are smaller than before.
- Flat gradients that carry meaning stay: the hue strip and the colour field in the picker, the transparency
  checkerboards, and the black-to-transparent scrim that keeps a caption legible over a photo. They are
  neutral or they are the control itself, never decoration.
- Text on the accent is `--accent-ink`, never white: menu hover, the highlighted picker row, the tag suggestion,
  the checked checkbox, the danger menu row.

### 3. Icons

- One set (lucide), one stroke: `svg.lucide { stroke-width: 1.5 }` in `styles.css`, with the extension's own
  icons on the same weight.
- No emoji left in the interface. The `🧮` logo became a drawn mark — a squared frame, a beam, three rods and six
  square beads, one colour — in the app, the favicon, the extension pages, the extension icons and the quick-add
  page. The PNG icons (16/32/48/128) and `apple-touch-icon.png` are rendered from the same glyph; the small
  sizes drop the beads so the mark still reads at 16px.
- Icons take their text role's colour and never a colour of their own.

### 4. Copy

- Uppercase labels became sentence case (`FOLDERS` → `Folders`), which is a CSS change here: the JSX was
  already written in sentence case and the CSS was shouting it.
- No exclamation marks, no trailing periods on short strings, no hype words, no greeting headlines. The empty
  state says `No matches` / `Try a different search or clear your filters.`
- Counts are quiet mono text, not pills.

### 5. Type

- The scale above; 15 distinct sizes became 6, and five declared weights became three (400 default, 500, 600).
- Letter spacing is 0 or slightly positive on meta; negative tracking only on the large landing headline.
- Figures are tabular.

### 6. Layout

Unchanged on purpose: the app keeps its real proportions — a 248px sidebar, fluid content, a 300px inspector,
the shell fills the viewport. What changed is inside the sections: the toolbar count is now quiet text, the
sidebar's section heads sit on the same 32px row rhythm as the rows under them, and the phone layout keeps its
two-row toolbar.

### 7. Details

- Selection: a 2px amber frame with a square tick. Hover: a hairline step, no lift and no shadow.
- Counts and meta are mono text; keyboard shortcuts are keycaps with `--font-mono`.
- The active setting is an amber 1px frame plus a 1px ring, with a square radio that keeps an inner square (the
  filled 5px border is what makes the inner square, which is why a radio reads as *on* without a dot).
- Charts: the app has progress bars, not charts. They are solid accent and the one that matters keeps the
  colour.
- The logo is flat: the wordmark in the interface family, the mark drawn in one colour. No gradient wordmark, no
  sparkle tile.

### 8. Visuals

Dashboards and app screens get their moments from the product: the thumbnails carry the colour, and the
moodboard is the second moment — images floating on a dark canvas with a faint 22px dot grid, square frames,
mono captions. No generated imagery, no blobs, orbs, or glowing grids. The demo landing keeps its product
preview (the real app rising into frame on scroll) instead of a decorative hero.

### 9. Motion

- Removed: the infinitely bobbing landing chevron, hover scales on colour swatches, dots, stars and viewer
  arrows, the subfolder card's lift, and the 2.5% thumbnail zoom on hover.
- Kept and named: colour, background, border and transform transitions for state feedback; one 0.12–0.2s
  duration band; one entrance per surface (`pop`, `modal-in`, `toast-in`, `sheet-in`), and the spin on the one
  real loading indicator.
- `width`/`height` transitions survive in exactly one place, the grid cards, because animating the thumbnail
  size is the feature the slider and the pinch gesture drive.

---

## Theming

The design above is the default, not the only look. **Settings → Appearance** carries the same three controls
Obsidian's appearance panel does, in the same order: a base colour scheme, a short theme list, and an accent
colour. There is no explanatory copy in that panel — labels only, which is the unslop rule for the rest of the app.

- **Base color scheme**: `light`, `dark`, `system` (the last follows the OS and repaints when it changes).
- **Themes**: `graphite` (warm neutral, the direction above), `slate` (cool), `sepia` (paper). Each theme is a hue
  and a saturation; the ramp is built from it, so a theme is not a separate stylesheet.
- **OLED mode**: a switch. In the dark scheme it drops every surface to true black and thickens the hairlines, so
  the edges still read without a lit panel. It is a third palette, not a filter over the dark one, and it is
  disabled while the light scheme is active.
- **Accent color**: six presets or any `#rrggbb`.
- **Corners**: `squared` (the design) or `rounded` (the corner scale the app had before).

### How it is stored

The theme is a **server setting**, not a browser preference: `GET`/`PATCH /api/settings/appearance`, stored under
the `appearance` key in the settings table. It is shared by every browser that opens the library, and the Chrome
extension reads the same endpoint so it cannot drift from the app. An extension API key may read it and may not
write it: `GET /api/settings/appearance` is on the token route allowlist, `PATCH` is not.

The server resolves the palettes, so no client re-implements the colour maths:

```json
{
  "scheme": "dark", "theme": "graphite", "corners": "squared", "oled": false,
  "accent": { "id": "amber", "hex": "#e8a33d", "ink": "#14120d", "soft": "rgba(232, 163, 61, 0.14)",
              "text": { "light": "#906526", "dark": "#e8a33d" } },
  "palettes": {
    "dark":  { "bg": "hsl(40 6% 6.5%)", "panel": "…", "text": "…", "primary": "…" },
    "light": { "bg": "hsl(40 6% 95%)",  "…": "…" },
    "oled":  { "bg": "hsl(40 6% 0%)",   "…": "…" }
  },
  "themes": [{ "id": "graphite", "label": "Graphite", "preview": { "light": {}, "dark": {} } }],
  "presets": [{ "id": "amber", "label": "Amber", "hex": "#e8a33d" }]
}
```

- A palette is 26 custom-property values: surfaces, hairlines, three text roles, the overlay/scrim/stage tones for
  menus, modals and the viewer, the two colours of the transparency checker, the shadow, and the primary plate.
- `ink` is whichever of near-black `#14120d` or paper `#f4f1ea` contrasts better with the accent (WCAG relative
  luminance); `text.light` is the accent darkened 38% for use as ink on light surfaces, so an amber label still
  passes 4.5:1 there.
- Themes and presets are part of the payload, so the settings panel renders whatever the server knows: adding a
  theme is one entry in `server/src/appearance.js`.
- `system` is resolved on the client (the server cannot see the OS), which is why the payload carries all three
  palettes rather than one.

### How it is applied

- **App**: `main.tsx` paints the cached appearance before the first render, then `App` fetches the server value,
  repaints, and listens to `prefers-color-scheme` while the scheme is `system`. `applyAppearance` sets
  `data-corners`, `data-scheme`, `color-scheme`, and the palette plus accent as inline custom properties. No
  component knows about the theme.
- **Radius**: `:root` sets every `--r-*` to `0`; `:root[data-corners='rounded']` restores the legacy scale
  (4/6/8/10/12/18/999px/50%). One block of CSS, not a second stylesheet.
- **Extension**: `theme-boot.js` is a classic script in `<head>`, so a themed popup paints before the first frame
  from a localStorage mirror. `theme.js` then reads the server value on connect and on every popup open, caches it
  in `chrome.storage.local` and repaints on change. It follows the OS too when the scheme is `system`. The
  background worker syncs on install and on startup, and the toolbar badge flash uses the accent. The injected page
  dock, toast and screenshot overlay receive the same custom properties on their shadow host.
- **The demo build** has no server, so `web/src/lib/theme.ts` mirrors the server's theme/ladder maths. The two
  files say so in their headers; keep them in step.

### The rounded theme is a scale, not a rewind

The old stylesheet had 117 `border-radius` declarations in 15 different values. Rounded mode does not restore that
sprawl: each rule now names a token, and the tokens bucket the old geometry — small chips 4px, controls 6–8px,
cards and thumbs 10px, menus 12px, modals and sheets 18px, pills full. The result reads like the app did before,
with a consistent scale on top instead of one-off values.

## Deviations, and what was not changed

- **The Details pass is overridden** (radius 0 instead of nested 8–20px radii), as the issue asked. This is the
  one place where the skill's own checklist does not apply.
- **The logo was redrawn**, although the skill says to keep a real logo. The old mark was the `🧮` emoji, which
  is not a drawn asset and renders as a hollow box on systems without an emoji font — it was already broken on
  this machine. The new mark is flat, square and one colour.
- **The family is the project's original Inter-led stack**, with the system grotesk behind it, because the app
  ships without webfonts. If it ever bundles a face, that is the one type decision to revisit.
- **The phone form-field size stays 16px** so iOS does not zoom on focus.
- **Marketing images are stale.** `preview.jpg`, `web/public-demo/preview/*.jpg` and the README screenshot still
  show the old blue-violet UI. They are generated from a running app (`npm run render:preview` at the repo
  root); regenerate them in a follow-up so the OG cards match the product.
- **The 1527ec0 image in the README** and the Docker/GHCR artefacts are untouched: this change is the interface,
  not a release.
- **Not done, on purpose:** no new decoration replaced the removed decoration — no glass, grain, noise or bento
  grid; the product's features, sections and order are unchanged.

## Checking it

```bash
npm run build                                  # web/src, tsc + vite
# no literal radii: every corner is a token, so the theme switch reaches all of them
grep -rnE "border-radius: [0-9]" web/src/styles.css web/src/demo.css extensions/chrome/*.css
grep -rn "accent-2\|accent-glow\|text-transform: uppercase" web/src extensions/chrome --include=*.css
npm test --prefix server
```

The first grep prints one line: `.modal.page` on phones, a full-screen dialog that stays square in both themes. The
second must print nothing.
