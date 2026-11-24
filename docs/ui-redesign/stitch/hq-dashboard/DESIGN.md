---
name: Velza Traceability Design System
colors:
  surface: '#f9f9fb'
  surface-dim: '#d9dadc'
  surface-bright: '#f9f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f5'
  surface-container: '#eeeef0'
  surface-container-high: '#e8e8ea'
  surface-container-highest: '#e2e2e4'
  on-surface: '#1a1c1d'
  on-surface-variant: '#5c3f3d'
  inverse-surface: '#2f3132'
  inverse-on-surface: '#f0f0f2'
  outline: '#916f6c'
  outline-variant: '#e6bdba'
  surface-tint: '#c0001f'
  primary: '#b9001d'
  on-primary: '#ffffff'
  primary-container: '#df2531'
  on-primary-container: '#fff9f8'
  inverse-primary: '#ffb3ae'
  secondary: '#5f5e60'
  on-secondary: '#ffffff'
  secondary-container: '#e2dfe1'
  on-secondary-container: '#636264'
  tertiary: '#5a5b5f'
  on-tertiary: '#ffffff'
  tertiary-container: '#737378'
  on-tertiary-container: '#fcfaff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad7'
  primary-fixed-dim: '#ffb3ae'
  on-primary-fixed: '#410004'
  on-primary-fixed-variant: '#930015'
  secondary-fixed: '#e4e2e4'
  secondary-fixed-dim: '#c8c6c8'
  on-secondary-fixed: '#1b1b1d'
  on-secondary-fixed-variant: '#474649'
  tertiary-fixed: '#e3e2e7'
  tertiary-fixed-dim: '#c7c6cb'
  on-tertiary-fixed: '#1a1b1f'
  on-tertiary-fixed-variant: '#46464b'
  background: '#f9f9fb'
  on-background: '#1a1c1d'
  surface-variant: '#e2e2e4'
typography:
  display:
    fontFamily: Inter
    fontSize: 2.25rem
    fontWeight: '700'
    lineHeight: 2.75rem
    letterSpacing: -0.025em
  headline-lg:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: '700'
    lineHeight: 2.25rem
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 1.375rem
    fontWeight: '700'
    lineHeight: 1.75rem
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '600'
    lineHeight: 1.5rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5rem
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.375rem
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '400'
    lineHeight: 1.125rem
    letterSpacing: 0.005em
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 0.8125rem
    fontWeight: '500'
    lineHeight: 1.25rem
    letterSpacing: -0.01em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0em
  label-caps:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: '600'
    lineHeight: 1rem
    letterSpacing: 0.06em
  metric-stat:
    fontFamily: Inter
    fontSize: 2rem
    fontWeight: '700'
    lineHeight: 2.25rem
    letterSpacing: -0.03em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-lg: 1.5rem
  margin: 1.5rem
  margin-mobile: 1rem
  space-2xs: 0.25rem
  space-xs: 0.5rem
  space-sm: 0.75rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
  space-2xl: 3rem
---

## Brand & Style

This design system establishes a high-precision, content-first B2B supply chain operating environment inspired by macOS and iPadOS system architecture. The platform prioritizes calm authority, dense operational legibility, and immediate data comprehension across mission-critical traceability operations.

### Personality & Emotional Response
- **Surgical Precision:** Every border, tabular numeric figure, and status pill communicates reliability and sub-millimeter exactness.
- **Calm & Uncluttered:** Extensive whitespace and subdued monochromatic neutrals recede into the canvas, allowing complex batch trees, serial hierarchies, and container matrices to lead visual attention.
- **Controlled Urgency:** Velza Red is strictly disciplined. It commands action rather than decorates, reserved only for primary calls-to-action, core brand signifiers, active navigation anchors, and programmatic focus states.

### Visual Style
The design blends **Corporate Modern** with **macOS Utility Minimal**:
- Monochromatic canvases framed with sub-pixel or 1px hairline dividers.
- Frosted top utility navigation bars featuring subtle system-level blur.
- Rounded rectangular cards and widget groups echoing Apple HIG system widget standards.
- Distinct split-view hierarchy with a permanent, slim left navigation rail and expansive content viewport.

## Colors

The color system delivers high contrast, frictionless legibility, and strict semantic segregation across both Light Mode (default) and Dark Mode.

### Palette Architecture
- **Primary Brand Red (`#DF2531`):** Strictly reserved for focal actions (e.g., active primary sidebar pills, primary action buttons, key icon accents, keyboard focus rings). It must never be applied casually as large surface backgrounds.
- **Light Theme Canvas:**
  - Base Application Canvas: `#F5F5F7`
  - Elevated Container / Cards: `#FFFFFF`
  - Hairline Border: `#E5E5EA`
  - Text Primary: `#1D1D1F`
  - Text Secondary: `#86868B`
  - Text Tertiary: `#AEAEB2`
- **Dark Theme Canvas:**
  - Base Application Canvas: `#0B0B0D`
  - Elevated Container / Cards: `#1C1C1E`
  - Hairline Border: `rgba(255, 255, 255, 0.08)`
  - Text Primary: `#F5F5F7`
  - Text Secondary: `#98989D`
  - Text Tertiary: `#636366`

### Semantic Feedback Tokens
- **Success:** `#34C759` (Batch active, scan verified, sync complete)
- **Warning:** `#FF9F0A` (Threshold warning, delayed sync, nearing expiry)
- **Danger:** `#FF3B30` (System error, recall active, failed validation)
- **Info:** `#0A84FF` (System notification, metadata hint, code inspection)

## Typography

The typography system relies on **Inter** paired with **JetBrains Mono** for serial identifiers, hardware addresses, and batch IDs.

### Rules & Formatting
- **Tabular Numerics:** All dynamic counters, table cells, metric widgets, and time markers must enable OpenType tabular numbers (`tnum`) to eliminate layout shift during live background data sync cycles.
- **Section Headers & Overlines:** Category indicators above display headlines (e.g., `VELZA ADMIN PORTAL`, `VELZA HQ`) utilize `label-caps` in uppercase, tracked out with `0.06em` letter spacing in secondary text tones.
- **Monospace Code Usage:** All lot codes, device hashes, cryptographic keys, and container IDs are rendered via `code-md` or `code-sm` inside subtle inline container tags to ensure scannability.

## Layout & Spacing

The interface employs a fixed-rail, fluid-content split viewport rooted strictly in an **8pt spatial rhythm**.

### Structural Architecture
- **Sidebar Rail:** Fixed 240px width on desktop viewports. Collapses to an icon-only dock (68px) on tablet viewports and hides behind a modal drawer on mobile screens.
- **Top Utility Header:** Fixed 56px height pinned to the top, housing context switches, user profiles, theme toggles, and breadcrumb trails.
- **Main Viewport Canvas:** Fluid grid with 1.5rem (24px) outer margin padding and 1rem (16px) standard component gutters.
- **Widget Metric Shelf:** Multi-column layout adapting seamlessly:
  - Desktop (>1280px): 5-column metric tier / 3-column navigation cards.
  - Tablet (768px - 1279px): 2 or 3-column cards.
  - Mobile (<768px): 1-column stack.

## Elevation & Depth

Visual hierarchy does not rely on deep drop shadows; instead, it adopts an Apple-native structural plane model utilizing **hairline low-contrast outlines** and **subtle surface tint tiers**.

### Layering Rules
- **Base Layer (Canvas):** `#F5F5F7` in light mode; `#0B0B0D` in dark mode.
- **Container Surfaces (Cards, Tables, Modals):** Crisp `#FFFFFF` (light) or `#1C1C1E` (dark), surrounded by a continuous 1px hairline border (`#E5E5EA` light, `rgba(255, 255, 255, 0.08)` dark).
- **Hairline Dividers:** Standard 1px lines without bevels to demarcate table headers, navigation groups, and card footers.
- **Interactive State Elevation:** Hovering over actionable cards raises surface luminosity slightly rather than casting heavy drop shadows. Optional ambient shadow is restricted to dropdown popovers and floating dialogue sheets:
  - *Popover Shadow:* `0px 4px 16px rgba(0, 0, 0, 0.06), 0px 1px 2px rgba(0, 0, 0, 0.04)` (Light) / `0px 8px 24px rgba(0, 0, 0, 0.45)` (Dark).

## Shapes

The design system establishes a unified squircle-inspired corner geometry (Level 2: Rounded).

### Spatial Radius Tokens
- **Standard Controls & Badges (0.5rem / 8px):** Text fields, search bars, buttons, dropdown selectors, and metadata chips.
- **Cards & Data Containers (1rem / 16px):** Grid dashboard cards, metric tiles, table wrap panels, and modular quick-access items.
- **Modal Dialogs & Large Sheets (1.5rem / 24px):** Inspection drawers, batch audit modals, and full-scale configuration overlays.
- **Icon Surrounds (0.75rem / 12px):** Subtle tinted square-round containers wrapping category icons (`#DF2531` at 8% opacity).

## Components

### Buttons
- **Primary:** Velza Red (`#DF2531`) background, solid white text, 8px border-radius, font-weight 600, height 36px (compact) or 40px (standard). Focus state produces a 2px offset ring in `#DF2531`.
- **Secondary / Ghost:** Transparent background with 1px border (`#E5E5EA` / `rgba(255, 255, 255, 0.1)`), secondary text color, turning primary text on hover.
- **Icon Buttons:** 32x32px or 36x36px square-rounded targets with centered SVG icons (16px or 18px), used for theme toggles, search code actions, and collapse triggers.

### Navigation Items & Sidebar Rails
- Active sidebar items receive a high-contrast pill treatment: bold Velza Red background with white text and icon, or subtle 10% red tint with red text in secondary navigation hierarchies.
- Inactive items retain secondary text color with clear 8px padding and subtle background hover illumination.

### Metric Cards & Quick-Access Widgets
- Built on `rounded-lg` (16px) cards with 1px hairline perimeter borders.
- Top-aligned category label with corresponding red-tinted icon enclosure (36x36px rounded square).
- Large display metric (`metric-stat`) paired with small tabular sub-labels.
- Interactive navigation cards feature an subtle arrow icon anchored to the upper-right corner.

### Data Tables & Status Chips
- **Tables:** Edge-to-edge layout within 16px rounded parent cards. Headers use `label-caps` in uppercase secondary gray. Rows feature hairline bottom borders with zero vertical borders for a clean scan.
- **Status Chips:** Low-saturation tinted pills (height 22px, radius 9999px) with a 6px status dot. 
  - *Generated / In Transit:* Green tint background (`rgba(52, 199, 89, 0.12)`), green text (`#34C759`).
  - *Alert / Flagged:* Red tint background (`rgba(223, 37, 49, 0.12)`), red text (`#DF2531`).

### Form Inputs & Code Search
- Single-line search bars and input fields have 8px radius, inset background (`#FFFFFF` in light mode, `#161618` in dark mode), and a hairline border.
- Monospace values auto-format serial masks and tracking numbers with fixed glyph spacing.
