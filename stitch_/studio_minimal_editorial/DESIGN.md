---
name: Studio Minimal Editorial
colors:
  surface: '#f9f9f8'
  surface-dim: '#dadad9'
  surface-bright: '#f9f9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f4f3'
  surface-container: '#eeeeed'
  surface-container-high: '#e8e8e7'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1a1c1c'
  on-surface-variant: '#4d4540'
  inverse-surface: '#2f3130'
  inverse-on-surface: '#f1f1f0'
  outline: '#7e7570'
  outline-variant: '#d0c4be'
  surface-tint: '#625d5b'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1e1b19'
  on-primary-container: '#888380'
  inverse-primary: '#ccc5c2'
  secondary: '#4b41e1'
  on-secondary: '#ffffff'
  secondary-container: '#645efb'
  on-secondary-container: '#fffbff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#002114'
  on-tertiary-container: '#069669'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e9e1dd'
  primary-fixed-dim: '#ccc5c2'
  on-primary-fixed: '#1e1b19'
  on-primary-fixed-variant: '#4a4643'
  secondary-fixed: '#e2dfff'
  secondary-fixed-dim: '#c3c0ff'
  on-secondary-fixed: '#0f0069'
  on-secondary-fixed-variant: '#3323cc'
  tertiary-fixed: '#85f8c4'
  tertiary-fixed-dim: '#68dba9'
  on-tertiary-fixed: '#002114'
  on-tertiary-fixed-variant: '#005137'
  background: '#f9f9f8'
  on-background: '#1a1c1c'
  surface-variant: '#e2e2e2'
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.02em
  code-formula:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: -0.01em
  code-cell:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-badge:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-sm: 0.5rem
  margin: 1.25rem
  margin-mobile: 0.75rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system establishes an AI-first workspace merging the analytical discipline of financial modeling with the serene clarity of an editorial publication. Tailored for quantitative analysts, data strategists, and executive operators, the interface replaces traditional spreadsheet clutter with purposeful spatial calm.

The visual style is **Minimal Editorial / Next-Gen AI Studio**:
- **Atmospheric Warmth**: Architectural stone and linen-tinted surfaces replace clinical grays, grounding dense tabular operations in an inviting, tactile environment.
- **Quiet Precision**: Restrained obsidian typography, razor-thin framing lines, and monospaced coordinates yield absolute clarity under cognitive load.
- **Ambient Intelligence**: AI activity is rendered through deliberate, contextual cues—luminous indigo inspection boundaries, amber staging states, and restrained emerald validations—rather than aggressive visual noise.

## Colors

The palette relies on a nuanced neutral foundation supported by functional semantic accents dedicated to spreadsheet states and autonomous agent dispatch.

### Foundational Palette
- **Canvas Base (`#FAFAF9`)**: Warm linen-tinted paper white for the studio canvas, reducing display glare during prolonged modeling sessions.
- **Surface Layer (`#FFFFFF`)**: Pure crisp white for active cell fields, data sheets, and elevated card decks.
- **Surface Container (`#F5F5F4`)**: Stone neutral used for cell headers, formula bars, and collapsible inspector panels.
- **Typography Obsidian (`#1C1917`)**: Deep stone black offering maximum contrast for formulas, numbers, and primary UI copy.
- **Muted Stone (`#78716C`)**: Soft slate-stone for grid coordinate indicators, inactive formulas, and secondary metadata.
- **Structural Border (`#E7E5E4`)**: Crisp 1px division for grids, dividers, and container bounds.

### Semantic & Agent Accents
- **Indigo Focus (`#4F46E5` / Background `#EEF2FF`)**: Denotes active AI inspection, range selection, and context-reading tools (`workbook_read`).
- **Amber Staging (`#D97706` / Background `#FEF3C7`)**: Signals pending agent transformations, confirmation gates, and non-blocking warnings.
- **Emerald Settlement (`#059669` / Background `#ECFDF5`)**: Marks confirmed agent mutations, valid formulas, and completed cell executions (`workbook_edit`).
- **Crimson Interrupt (`#DC2626` / Background `#FEF2F2`)**: Reserved for halt states, critical formula syntax errors, and model intervention.

## Typography

The typographic hierarchy establishes clear boundaries between narrative content, analytical data, and runtime agent operations.

- **Primary Typeface**: **Plus Jakarta Sans** provides a contemporary geometric structure softened by open counters. It directs system headers, reasoning narratives, and interactive controls.
- **Monospaced Technical Font**: **JetBrains Mono** governs the data plane. It enforces uniform vertical column scanning using tabular figures (`tnum`) and slashed zeros (`zero`) across spreadsheet coordinates, cell metrics, formula bars, and range badges.
- **Vertical Rhythm**: Compact line-heights in tabular environments preserve vertical density, while breathing room is maintained in conversational AI cards.

## Layout & Spacing

The architecture operates on an asymmetric dual-pane split optimized for dual-focus workflows: primary modeling and autonomous execution.

### Grid & Workbench Model
- **Spreadsheet Canvas (Flexible Width)**: Fluid container adapting from 60% to 75% viewport width. Uses a persistent 28px coordinate header track with seamless horizontal/vertical scrolling.
- **AI Agent Studio Pane (Fixed/Collapsible)**: Occupies 380px to 440px on the right. Houses interactive tool cards, context stacks, and prompt controls. Collapsible to a 48px micro-rail on compact viewports.
- **Formula & Command Bar**: Fixed 36px ribbon pinned above the active sheet viewport, anchored seamlessly to the row/column header origin.

### Responsive Breakpoints
- **Desktop (>= 1280px)**: Co-present split screen. Grid operations and agent feedback operate in parallel without visual collision.
- **Tablet / Small Laptop (1024px – 1279px)**: Agent pane collapses to 360px overlay drawer; formula bar dynamically wraps or abbreviates range references.
- **Mobile (< 1023px)**: Sheet becomes the single view; AI agent functions as a bottom sheet drawer with a minimized quick-steer toolbar.

## Elevation & Depth

This system avoids heavy drop shadows, relying instead on structural 1px borders, subtle tone shifts, and low-opacity ambient layers to designate interactive tiers.

- **Level 0 (Surface Base)**: The spreadsheet grid itself, flat `#FFFFFF` cells bounded by `#E7E5E4` 1px lines.
- **Level 1 (Sub-Panels & Formula Bar)**: `#F5F5F4` backgrounds with subtle `border-stone-200`, flat without shadow.
- **Level 2 (Floating Action Bars & Agent Cards)**: Elevated AI cards and floating prompt bars use `#FFFFFF` surfaces paired with a soft ambient shadow: `0 4px 20px -2px rgba(28, 25, 23, 0.05), 0 0 1px 1px rgba(28, 25, 23, 0.04)`.
- **Level 3 (Confirmation Overlays & Popovers)**: Context menus and range confirmation previews use an elevated layer with `0 12px 32px -4px rgba(28, 25, 23, 0.08)`.
- **Dashed Staging Overlays**: Visual priority on the sheet is commanded via high-contrast borders rather than elevation, isolating reading states with dashed indigo outlines and pending modifications with amber boundaries.

## Shapes

The design leverages a tiered corner radius system reflecting component scale and role:

- **Spreadsheet Cells**: Strict geometric right angles (`0px`) to preserve structural cell boundary lines and numerical alignment.
- **Micro UI & Badges (`rounded-sm` / 4px)**: Cell coordinates, tool chips, status dots, and inline cell tags.
- **Interactive Elements (`rounded-md` / 8px)**: Buttons, formula bar inputs, tool call disclosure blocks.
- **Containers & Agent Panels (`rounded-xl` / 16px)**: Agent execution cards, floating prompt controls, and primary studio frames.

## Components

### 1. Spreadsheet Studio Components
- **Formula Bar**: 36px fixed ribbon. Features a dedicated function token button (`fx`), a monospaced named-range dropdown (`JetBrains Mono`, 12px), and a stone-tinted input area that auto-expands on multiline formula edits.
- **Grid Lines & Header Cells**: Bounded by 1px `#E7E5E4`. Headers feature neutral stone `#F5F5F4` background with obsidian label text (`JetBrains Mono`, 11px, centered).
- **Cell States**:
  - *Active User Focus*: Solid 2px `#1C1917` ring with a 4px corner fill handle.
  - *Agent Reading*: 1.5px dashed `#4F46E5` border with subtle `#EEF2FF` interior fill.
  - *Agent Pending Mutation*: 1.5px dashed `#D97706` border with soft `#FEF3C7` fill.
  - *Settled Mutation*: Pale emerald `#ECFDF5` background with an absolute 4px emerald dot badge positioned in the upper-right corner.

### 2. AI Agent Panel & Tool Cards
- **Thinking State Chips**: Collapsible pill chips displaying animated status indicators (`12px` typography, `#78716C` text, `#F5F5F4` background) that expand into step-by-step reasoning logs.
- **Interactive Tool Execution Cards**: Clean containers (`rounded-xl`, 1px `#E7E5E4` border, `#FFFFFF` background). Includes a top status header showing the tool name (`workbook_read` or `workbook_edit`), an elapsed execution timer, and inline range badges.
- **Cell Range Badges**: Pill-shaped badges using `JetBrains Mono` (`code-badge`), styled with neutral stone borders or semantic tinting (e.g., `Sheet1!B2:D9` with subtle indigo background for query targets).

### 3. Execution Control & Dispatch Bar
- **Pending Interaction Banner**: Slotted directly above the prompt bar. Displays staged agent plans with targeted cell previews, a unified "Review Changes" summary, and an amber confirmation toggle.
- **Multi-Mode Dispatch Group**: Segmented action cluster featuring:
  - *Steer*: Primary action, deep obsidian button (`#1C1917`) with crisp white text.
  - *Interrupt*: Subtle crimson ghost button (`#DC2626` hover state) for instant agent halting.
  - *Queue*: Secondary outline button (`#E7E5E4` border) to append instructions without canceling current execution.

### 4. Input Fields & Form Controls
- **Prompt Bar Input**: Borderless, multi-line auto-resizing text field housed within a floating `rounded-xl` container with subtle ambient shadow. Includes shortcut indicators (`⌘ Enter`) and attachment pills for range referencing.
- **Checkboxes & Radios**: 14px compact squares/circles using `#1C1917` for active check states, built for rapid row selection without breaking grid rhythm.