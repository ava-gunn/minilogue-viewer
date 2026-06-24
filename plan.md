# Minilogue XD Patch Viewer — Project Plan

A vanilla TypeScript web application that parses Korg Minilogue XD preset files
(`.mnlgxdprog` / `.mnlgxdlib`) and drives an interactive panel UI through a
typed custom event bus. Styled with Web Awesome design tokens; supplemented by
Web Awesome components where they earn their place.

---

## Tech Stack

| Concern | Choice |
|---|---|
| Build tool | **Vite 8** (Rolldown bundler) |
| Language | **TypeScript 5.x** strict, `verbatimModuleSyntax`, `NodeNext` |
| Design system | **Web Awesome** (`@awesome.me/webawesome`) — tokens + selected components |
| Synth controls | **Custom Web Components** (`<xd-knob>`, `<xd-switch>`, etc.) consuming WA tokens |
| Linting + formatting | **Biome** |
| Schema validation | **Zod** |
| Unit tests | **Vitest** |
| E2E tests | **Playwright** |
| Package manager | **pnpm** |
| Commits | **Commitlint** + conventional commits |

No React. No Tailwind. No Svelte. No state library.

---

## Web Awesome Integration

### What Web Awesome provides

Web Awesome is the successor to Shoelace — a full CSS framework and web
component library. For this project it serves two distinct purposes:

**1. Design token foundation**

Design tokens are CSS custom properties prefixed with `--wa-`. Use them in your
own stylesheets by wrapping the token name in the `var()` function. This
gives our custom synth controls a shared, consistent vocabulary for spacing,
color, shadow, and typography — without any utility class system.

Token categories used in this project:

| Token prefix | Examples | Used for |
|---|---|---|
| `--wa-color-*` | `--wa-color-teal-40`, `--wa-color-neutral-10` | Knob bodies, panel backgrounds, LED colors |
| `--wa-space-*` | `--wa-space-xs`, `--wa-space-m` | Section padding, knob label gaps |
| `--wa-shadow-*` | `--wa-shadow-s`, `--wa-shadow-m` | Panel section depth |
| `--wa-border-*` | `--wa-border-width-s`, `--wa-border-style` | Section borders |
| `--wa-font-family-*` | `--wa-font-family-mono` | Panel labels and LCD value readout |
| `--wa-transition-*` | `--wa-transition-medium` | Knob animation easing |

**2. Ready-made components**

Components expose parts that allow styling any standard CSS property via
`::part()` selectors, which is much more robust than implicit selectors.
We use WA components only where they replace non-trivial custom work:

| WA component | Where used |
|---|---|
| `<wa-tooltip>` | Knob value readout on hover/focus |
| `<wa-details>` | Collapsible library drawer when `.mnlgxdlib` loaded |
| `<wa-divider>` | Section separators in panel |
| `<wa-badge>` | Effects on/off indicators (MOD, DLY, REV) |
| `<wa-icon>` | Waveform glyphs (SQR/TRI/SAW) via Font Awesome |

Everything else — layout, panel sections, the synth controls themselves — is
custom CSS + custom Web Components consuming WA tokens.

### Installation

```typescript
// src/styles/main.css
/* Theme layer — required, provides all --wa-* custom properties */
@import '@awesome.me/webawesome/dist/styles/themes/default.css';

/* Skip native.css — it applies opinionated resets to <button>, <input> etc.
   that would interfere with our custom synth controls.
   If needed later, scope with: .native-reset-zone :where(button, input) { all: revert } */

/* Our overrides layered on top of WA tokens */
@import './theme.css';
```

```typescript
// src/main.ts
// Cherry-pick only the WA components we actually use
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
```

### Theme overrides (`src/styles/theme.css`)

WA's dark mode is applied via the `.wa-dark` class. We scope the entire panel
to dark mode and override the brand color to match the Minilogue XD's teal accent:

```css
/* src/styles/theme.css */

/* Scope entire app to dark mode */
html {
  color-scheme: dark;
}

/* Override WA tokens for our dark hardware aesthetic.
   Scoped to .wa-dark per WA's theming convention. */
.wa-dark,
:where(:root) {
  /* Remap brand to Minilogue XD teal */
  --wa-color-brand: var(--wa-color-teal);
  --wa-color-brand-fill-normal: oklch(from var(--wa-color-teal-40) l c h / 1);

  /* Panel surfaces — deeper than WA defaults */
  --wa-color-surface-default: #1a1a1e;
  --wa-color-surface-raised:  #242428;
  --wa-color-surface-overlay: #2e2e36;

  /* Subdued border for section dividers */
  --wa-color-neutral-border-normal: #3a3a42;

  /* LCD green phosphor as a custom token */
  --xd-lcd-text:    oklch(85% 0.18 140);
  --xd-lcd-bg:      oklch(15% 0.04 140);

  /* Knob accent colors */
  --xd-knob-teal:   var(--wa-color-teal-40);
  --xd-knob-body:   var(--wa-color-surface-overlay);
  --xd-led-on:      var(--wa-color-teal-40);
  --xd-led-off:     oklch(20% 0.05 180);

  /* Panel label style */
  --xd-label-color: var(--wa-color-neutral-40);
  --xd-font:        var(--wa-font-family-mono);
}
```

> **Note:** `--xd-*` tokens are project-specific and distinct from `--wa-*`.
> WA tokens are the foundation; `--xd-*` tokens are synth-specific aliases
> or custom values that have no WA equivalent.

---

## Project Structure

```
minilogue-xd-viewer/
├── biome.json
├── .env.example
├── .gitignore
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
│
├── src/
│   ├── main.ts                        # Entry — imports WA components, registers custom WCs, inits sections
│   │
│   ├── styles/
│   │   ├── main.css                   # WA theme import + our theme.css
│   │   ├── theme.css                  # WA token overrides + --xd-* tokens
│   │   ├── panel.css                  # CSS Grid panel layout
│   │   └── components.css             # Shared custom WC styles (shadow DOM can @import this)
│   │
│   ├── events/
│   │   ├── bus.ts
│   │   └── types.ts
│   │
│   ├── parser/
│   │   ├── unzip.ts                   # fflate → prog_bin ArrayBuffers
│   │   ├── binary.ts                  # DataView → RawPatch
│   │   ├── transforms.ts              # pitchCents, egInt, lfoRate, voiceModeDepth
│   │   ├── enums.ts                   # All enum/lookup tables
│   │   ├── patch.ts                   # RawPatch → MinilogueXDPatch
│   │   └── schema.ts                  # Zod schema
│   │
│   ├── components/                    # Custom Web Components
│   │   ├── xd-knob.ts
│   │   ├── xd-wave-selector.ts
│   │   ├── xd-switch.ts
│   │   ├── xd-led-group.ts
│   │   └── xd-dropzone.ts
│   │
│   ├── sections/
│   │   ├── oscillator.ts
│   │   ├── mixer.ts
│   │   ├── filter.ts
│   │   ├── envelope.ts
│   │   ├── lfo.ts
│   │   ├── voice.ts
│   │   └── effects.ts
│   │
│   ├── panels/
│   │   ├── lcd.ts                     # Program name + patch metadata
│   │   └── library.ts                 # Program list for .mnlgxdlib files
│   │
│   └── types/
│       └── synth.ts
│
└── e2e/
    └── viewer.spec.ts
```

---

## Custom Web Components

Each custom component lives in Shadow DOM and imports WA tokens at construction
time via a `CSSStyleSheet` or inline `<style>`. They communicate exclusively
through the event bus.

### Token consumption pattern

Custom components pull WA and `--xd-*` tokens from `:host` using `inherit`:

```typescript
// src/components/xd-knob.ts
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: var(--wa-space-xs);
    font-family: var(--xd-font);
  }

  .knob-body {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    background: var(--xd-knob-body);
    box-shadow: var(--wa-shadow-s);
    position: relative;
    cursor: pointer;
    transition: transform var(--wa-transition-fast);
  }

  .indicator {
    position: absolute;
    top: 50%; left: 50%;
    width: 2px; height: 45%;
    background: var(--xd-knob-teal);
    transform-origin: bottom center;
    transform: translateX(-50%) rotate(var(--knob-angle, -135deg));
    transition: transform var(--wa-transition-medium) cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 1px;
  }

  :host([data-highlight="teal"]) .ring {
    box-shadow: 0 0 0 2px var(--xd-knob-teal), var(--wa-shadow-s);
  }

  .label {
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--xd-label-color);
  }

  @media (prefers-reduced-motion: reduce) {
    .indicator { transition: none; }
  }
`);

class XdKnob extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' });

  connectedCallback() {
    this.#shadow.adoptedStyleSheets = [sheet];
    this.#render();
    this.#bindEvents();

    this.#unsubscribe = on('param:change', ({ section, key, value }) => {
      if (section === this.dataset.section && key === this.dataset.paramKey) {
        this.#animateTo(value);
      }
    });
  }

  #animateTo(value: number) {
    // Map 0–1 to −135deg → +135deg (270deg total sweep)
    const angle = -135 + value * 270;
    this.style.setProperty('--knob-angle', `${angle}deg`);
  }
}

customElements.define('xd-knob', XdKnob);
```

### WA tooltip wrapping knob value

Rather than building a custom tooltip, the knob uses `<wa-tooltip>` from the
host document. The knob fires a `CustomEvent` upward; the section module wraps
the knob in a `<wa-tooltip>` and updates its `content` attribute reactively:

```html
<!-- In panel HTML -->
<wa-tooltip content="0%" placement="top" hoist>
  <xd-knob label="CUTOFF" data-section="filter" data-param-key="cutoff"></xd-knob>
</wa-tooltip>
```

```typescript
// In filter.ts section module
on('param:change', ({ section, key, value }) => {
  if (section === 'filter' && key === 'cutoff') {
    const tip = root.querySelector<Element>('wa-tooltip[data-for="cutoff"]');
    tip?.setAttribute('content', `${Math.round(value * 100)}%`);
  }
});
```

### `<xd-wave-selector>`

Renders three `<button>` elements (SQR / TRI / SAW) inside Shadow DOM, each
using a `<wa-icon>` for the waveform glyph. Active button gets
`--wa-color-brand-fill-normal` as background.

```typescript
const WAVES = [
  { value: 0, label: 'SQR', icon: 'wave-square' },
  { value: 1, label: 'TRI', icon: 'wave-triangle' },  // custom FA icon
  { value: 2, label: 'SAW', icon: 'wave-sawtooth' },  // custom FA icon
] as const;
```

### `<xd-switch>`

Two-position rocker styled with WA tokens. Renders as a labeled `<button
role="switch" aria-checked>`. Uses `--wa-color-brand` for the active state and
`--wa-color-neutral-surface-quiet` for inactive.

### `<xd-led-group>`

Row of `<span role="radio">` elements styled as LED indicators. Active LED uses
`--xd-led-on`; inactive uses `--xd-led-off` with `box-shadow: none`.

### `<xd-dropzone>`

Full-bleed drop zone. On file accept, shows filename in a `<wa-badge>` variant
`"brand"`. Error state (wrong file type) uses `<wa-badge variant="danger">`.

---

## Panel HTML Layout

The panel uses `class="wa-dark"` to activate WA dark-mode tokens across all WA
components and inherited custom properties:

```html
<!DOCTYPE html>
<html lang="en" class="wa-dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minilogue XD Viewer</title>
  <link rel="stylesheet" href="/src/styles/main.css">
</head>

<body>
<div id="xd-panel">

  <!-- LCD header -->
  <header id="lcd-bar">
    <div id="lcd-screen">
      <span id="program-name">INIT PROGRAM</span>
      <span id="program-index"></span>
    </div>
    <xd-dropzone accept=".mnlgxdprog,.mnlgxdlib" id="file-drop"></xd-dropzone>
  </header>

  <wa-divider></wa-divider>

  <!-- Voice / Portamento row -->
  <section id="voice-section" class="panel-section">
    <span class="section-label">VOICE</span>
    <xd-led-group
      data-section="voice"
      data-param-key="mode"
      labels="POLY,ARP,CHORD,UNISON">
    </xd-led-group>
    <wa-divider vertical></wa-divider>
    <wa-tooltip content="0 oct" placement="top" hoist>
      <xd-knob label="TUNE"  data-section="voice" data-param-key="octave"></xd-knob>
    </wa-tooltip>
    <wa-tooltip content="0%" placement="top" hoist>
      <xd-knob label="PORTA" data-section="voice" data-param-key="portamento"></xd-knob>
    </wa-tooltip>
  </section>

  <wa-divider></wa-divider>

  <!-- Main oscillator / mixer / filter row -->
  <div id="main-row">

    <section class="panel-section" id="vco1-section">
      <span class="section-label">VCO 1</span>
      <xd-wave-selector data-section="vco1" data-param-key="wave"></xd-wave-selector>
      <xd-knob label="OCT"   data-section="vco1" data-param-key="octave"></xd-knob>
      <wa-tooltip content="0¢" placement="top" hoist>
        <xd-knob label="PITCH" data-section="vco1" data-param-key="pitchCents"></xd-knob>
      </wa-tooltip>
      <xd-knob label="SHAPE" data-section="vco1" data-param-key="shape"></xd-knob>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="vco2-section">
      <span class="section-label">VCO 2</span>
      <xd-wave-selector data-section="vco2" data-param-key="wave"></xd-wave-selector>
      <xd-knob  label="OCT"      data-section="vco2" data-param-key="octave"></xd-knob>
      <wa-tooltip content="0¢" placement="top" hoist>
        <xd-knob label="PITCH"   data-section="vco2" data-param-key="pitchCents"></xd-knob>
      </wa-tooltip>
      <xd-knob  label="SHAPE"    data-section="vco2" data-param-key="shape"></xd-knob>
      <xd-knob  label="X.MOD"    data-section="vco2" data-param-key="crossModDepth"></xd-knob>
      <xd-switch label="SYNC"    data-section="vco2" data-param-key="sync"></xd-switch>
      <xd-switch label="RING"    data-section="vco2" data-param-key="ring"></xd-switch>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="multi-section">
      <span class="section-label">MULTI ENGINE</span>
      <xd-led-group data-section="multi" data-param-key="type" labels="NOISE,VPM,USER"></xd-led-group>
      <xd-knob label="SHAPE"       data-section="multi" data-param-key="shape"></xd-knob>
      <xd-knob label="SHIFT SHAPE" data-section="multi" data-param-key="shiftShape"></xd-knob>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="mixer-section">
      <span class="section-label">MIXER</span>
      <xd-knob label="VCO1"  data-section="mixer" data-param-key="vco1"></xd-knob>
      <xd-knob label="VCO2"  data-section="mixer" data-param-key="vco2"></xd-knob>
      <xd-knob label="MULTI" data-section="mixer" data-param-key="multi"></xd-knob>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="filter-section">
      <span class="section-label">FILTER / AMP</span>
      <xd-knob   label="CUTOFF"    data-section="filter" data-param-key="cutoff"></xd-knob>
      <xd-knob   label="RESONANCE" data-section="filter" data-param-key="resonance"></xd-knob>
      <xd-switch label="DRIVE"     data-section="filter" data-param-key="drive"></xd-switch>
      <xd-switch label="KEY TRACK" data-section="filter" data-param-key="keyTracking"></xd-switch>
    </section>

  </div>

  <wa-divider></wa-divider>

  <!-- Lower EG / LFO / FX row -->
  <div id="lower-row">

    <section class="panel-section" id="amp-env-section">
      <span class="section-label">AMP EG</span>
      <xd-knob label="ATK" data-section="ampEnv" data-param-key="attack"></xd-knob>
      <xd-knob label="DCY" data-section="ampEnv" data-param-key="decay"></xd-knob>
      <xd-knob label="SUS" data-section="ampEnv" data-param-key="sustain"></xd-knob>
      <xd-knob label="REL" data-section="ampEnv" data-param-key="release"></xd-knob>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="filter-env-section">
      <span class="section-label">EG</span>
      <xd-knob   label="ATK"    data-section="filterEnv" data-param-key="attack"></xd-knob>
      <xd-knob   label="DCY"    data-section="filterEnv" data-param-key="decay"></xd-knob>
      <wa-tooltip content="0%" placement="top" hoist>
        <xd-knob label="EG INT" data-section="filterEnv" data-param-key="int"></xd-knob>
      </wa-tooltip>
      <xd-switch label="TARGET"  data-section="filterEnv" data-param-key="target"></xd-switch>
    </section>

    <wa-divider vertical></wa-divider>

    <section class="panel-section" id="lfo-section">
      <span class="section-label">LFO</span>
      <xd-wave-selector data-section="lfo" data-param-key="wave"></xd-wave-selector>
      <xd-switch label="MODE"   data-section="lfo" data-param-key="mode"></xd-switch>
      <xd-knob   label="RATE"   data-section="lfo" data-param-key="rate"></xd-knob>
      <xd-knob   label="INT"    data-section="lfo" data-param-key="int"></xd-knob>
      <xd-switch label="TARGET" data-section="lfo" data-param-key="target"></xd-switch>
    </section>

    <wa-divider vertical></wa-divider>

    <!-- FX on/off shown as wa-badge; full FX params in collapsible details -->
    <section class="panel-section" id="effects-section">
      <span class="section-label">FX</span>
      <div class="fx-badges">
        <wa-badge id="modfx-badge"  variant="neutral">MOD</wa-badge>
        <wa-badge id="delay-badge"  variant="neutral">DLY</wa-badge>
        <wa-badge id="reverb-badge" variant="neutral">REV</wa-badge>
      </div>
      <xd-knob label="TIME"  data-section="reverb" data-param-key="time"></xd-knob>
      <xd-knob label="DEPTH" data-section="reverb" data-param-key="depth"></xd-knob>
    </section>

  </div>

</div>

<!-- Library drawer — wa-details for progressive disclosure -->
<wa-details id="library-panel" summary="Program Library" hidden>
  <ol id="program-list"></ol>
</wa-details>

<script type="module" src="/src/main.ts"></script>
</body>
</html>
```

---

## Panel CSS (`src/styles/panel.css`)

Layout uses CSS Grid; WA tokens provide all spacing and color values:

```css
/* src/styles/panel.css */

#xd-panel {
  display: grid;
  grid-template-rows: auto auto 1fr auto 1fr;
  background: var(--wa-color-surface-default);
  color: var(--wa-color-neutral-on-normal);
  font-family: var(--xd-font);
  min-height: 100dvh;
  padding: var(--wa-space-s);
  gap: 0;
}

#lcd-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--wa-space-xs) var(--wa-space-m);
  background: var(--xd-lcd-bg);
  border-radius: var(--wa-border-radius-m);
  margin-bottom: var(--wa-space-s);
}

#lcd-screen {
  color: var(--xd-lcd-text);
  font-family: var(--xd-font);
  font-size: var(--wa-font-size-s);
  letter-spacing: 0.05em;
}

#main-row,
#lower-row {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: auto;
  align-items: start;
  gap: 0;
  overflow-x: auto;
}

.panel-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--wa-space-s);
  padding: var(--wa-space-m) var(--wa-space-l);
  background: var(--wa-color-surface-raised);
}

.section-label {
  font-size: 0.6rem;
  font-family: var(--xd-font);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--xd-label-color);
  align-self: flex-start;
}

/* FX badges — active = brand (teal), inactive = neutral */
.fx-badges {
  display: flex;
  gap: var(--wa-space-xs);
}

wa-badge[data-active="true"] {
  --background-color: var(--wa-color-brand-fill-normal);
  --color: var(--wa-color-brand-on-normal);
}

/* Library panel */
#library-panel {
  margin-top: var(--wa-space-m);
}

#program-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: var(--wa-space-xs);
}

#program-list li {
  padding: var(--wa-space-xs) var(--wa-space-s);
  border-radius: var(--wa-border-radius-s);
  cursor: pointer;
  font-family: var(--xd-font);
  font-size: var(--wa-font-size-s);
  color: var(--wa-color-neutral-on-quiet);
  border: var(--wa-border-width-s) solid transparent;
}

#program-list li:hover {
  background: var(--wa-color-surface-overlay);
  border-color: var(--wa-color-neutral-border-normal);
}

#program-list li[aria-selected="true"] {
  background: var(--wa-color-brand-fill-quiet);
  border-color: var(--wa-color-brand-border-normal);
  color: var(--wa-color-brand-on-quiet);
}

@media (max-width: 800px) {
  #main-row,
  #lower-row {
    grid-auto-flow: row;
    grid-auto-columns: unset;
  }
}
```

---

## Effects badge update (`src/sections/effects.ts`)

```typescript
on('patch:load', ({ patch }) => {
  const setBadge = (id: string, on: boolean) => {
    const badge = document.getElementById(id);
    badge?.setAttribute('data-active', String(on));
    badge?.setAttribute('variant', on ? 'brand' : 'neutral');
  };

  setBadge('modfx-badge',  patch.modFx.on);
  setBadge('delay-badge',  patch.delay.on);
  setBadge('reverb-badge', patch.reverb.on);
});
```

---

## Milestones

### M1 — Scaffold
- [ ] `pnpm create vite@latest . -- --template vanilla-ts`
- [ ] TypeScript config: `strict`, `verbatimModuleSyntax`, `NodeNext`
- [ ] Biome config
- [ ] Install: `@awesome.me/webawesome`, `fflate`, `zod`
- [ ] Import WA theme CSS in `src/styles/main.css`
- [ ] Write `src/styles/theme.css` — WA overrides + `--xd-*` token definitions
- [ ] Add `class="wa-dark"` to `<html>`
- [ ] Cherry-pick WA component imports in `main.ts`

### M2 — Event Bus
- [ ] `src/events/bus.ts` — typed `emit` / `on` / unsubscribe
- [ ] `src/events/types.ts` — full `AppEventMap`
- [ ] Vitest: emit → handler receives typed payload

### M3 — Binary Parser
- [ ] `src/parser/enums.ts`
- [ ] `src/parser/transforms.ts` — `pitchCents`, `egInt`, `lfoRate`, `voiceModeDepth`
- [ ] `src/parser/binary.ts` — `readRawPatch`
- [ ] `src/parser/patch.ts` — `parsePatch`
- [ ] `src/parser/schema.ts` — Zod schema
- [ ] `src/parser/unzip.ts` — fflate wrapper
- [ ] Vitest: parse fixture `.mnlgxdprog`, assert known field values
- [ ] Vitest: all transforms against spec input/output pairs

### M4 — Custom Web Components
- [ ] `<xd-knob>` — Shadow DOM, CSSStyleSheet, `--wa-*` + `--xd-*` tokens, ARIA slider
- [ ] `<xd-wave-selector>` — SQR/TRI/SAW, `<wa-icon>` glyphs
- [ ] `<xd-switch>` — 2-position, `role="switch"`, `aria-checked`
- [ ] `<xd-led-group>` — `role="radiogroup"`, teal/off LEDs
- [ ] `<xd-dropzone>` — drag/browse, `<wa-badge>` for status
- [ ] Vitest: each component's event behavior

### M5 — Panel HTML + Layout
- [ ] `index.html` full panel structure with WA components in place
- [ ] `src/styles/panel.css` — CSS Grid layout, all values from `--wa-*` / `--xd-*`
- [ ] `<wa-details>` library drawer
- [ ] `<wa-divider>` section separators
- [ ] `<wa-tooltip>` on all knobs
- [ ] `<wa-badge>` FX indicators

### M6 — Section Modules + Orchestration
- [ ] All `init*Section()` modules wired in `main.ts`
- [ ] `main.ts`: `file:dropped` → parse → validate → `patch:load` → fan-out `param:change`
- [ ] `src/panels/library.ts` — program list renders from `file:parsed-lib`, click → `patch:load`
- [ ] `src/panels/lcd.ts` — updates `#program-name` and `#program-index` on `patch:load`
- [ ] Effects badge update from `src/sections/effects.ts`
- [ ] Error display (wrong file type → `<wa-badge variant="danger">`)

### M7 — Testing + Polish
- [ ] Playwright: drop `.mnlgxdprog` → assert `--knob-angle` on cutoff knob changed
- [ ] Playwright: drop `.mnlgxdlib` → `<wa-details>` library opens, click item → panel updates
- [ ] Keyboard accessibility audit — all custom WCs pass focus correctly, WA components self-manage
- [ ] `prefers-reduced-motion` audit on `<xd-knob>` transitions

---

## Data Flow Summary

```
<xd-dropzone> receives file
      │
      ▼
emit('file:dropped', { file })
      │
      ▼
main.ts: fflate unzip → prog_bin Uint8Array(s)
      │
      ▼
readRawPatch(bin) → DataView over 1024 bytes → RawPatch
      │
      ▼
parsePatch(raw) → transforms + enum lookups → MinilogueXDPatch
      │
      ▼
MinilogueXDPatchSchema.parse() → Zod validates at boundary
      │
      ├── .mnlgxdlib → emit('file:parsed-lib') → <wa-details> library renders
      │
      ▼
emit('patch:load', { patch })
      │
      ├── lcd.ts → #program-name, #program-index
      ├── effects.ts → <wa-badge> variants
      └── main.ts fans out param:change for every numeric parameter
                │
                ▼
        <xd-knob> animates via --knob-angle
        <xd-wave-selector> updates active glyph
        <xd-switch> updates aria-checked
        <xd-led-group> updates active LED
        <wa-tooltip> content attribute updated by section module
```

---

## Reference Links

- **Web Awesome docs:** https://webawesome.com/docs/
- **WA customizing / theming:** https://webawesome.com/docs/customizing
- **WA color tokens:** https://webawesome.com/docs/tokens/color/
- **Official Minilogue XD MIDI / file spec:** https://www.korg.com/us/support/download/manual/0/811/4440/
- **Python parser gist (gekart):** https://gist.github.com/gekart/b187d3c16e6160571ccfcf6c597fea3f

---

## Future Phases

| Phase | Feature |
|---|---|
| 2 | Gemini audio analysis — drop audio, get patch estimate displayed on same panel |
| 3 | WebMIDI adapter — `param:change` → MIDI CC → live hardware |
| 4 | SysEx export — write panel state back to `.mnlgxdprog` |
| 5 | Patch comparison — diff two patches side by side |
