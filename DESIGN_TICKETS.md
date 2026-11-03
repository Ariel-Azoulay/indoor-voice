# Indoor Voice — UI/UX design tickets

**Status: CLOSED — implemented and verified on 2026-10-31.**

Closure verification: `npm run build`, `npm run check` (TypeScript and Cargo), `git diff --check`, seven-page desktop visual review, runtime console review, navigation target/ARIA smoke checks, first-run state review, and floating-overlay compile/configuration review. Packaged VoiceOver behavior remains part of release QA because a transparent focusless WebView cannot be validated in the browser preview.

Audit basis: current desktop build at 1280×720, all seven primary pages, the floating pill, Apple-style desktop interaction principles, and Wispr Flow's public product language as a reference (not a visual template).

## IV-001 — Establish a calmer, semantic color system

**Priority:** P0  
**Area:** Global visual system

**Issue**

The app mixes two accents (electric blue for selection/actions and green for privacy/local state), near-black surfaces, warm charcoal cards, and a blue-purple hero. Each color works alone, but together they read as several products. Blue also currently means both “selected” and “primary,” while green means privacy, success, live audio, and sometimes selection.

**Fix**

- Introduce semantic tokens for canvas, elevated surface, separator, primary text, secondary text, accent, privacy/local, success, warning, and destructive.
- Use system blue only for focus, selection, and primary actions.
- Reserve green for local/privacy/live/success status; do not use it for ordinary selection.
- Reduce the hero's blue cast so it belongs to the same graphite/green family as the rest of the product.
- Verify colors in light mode, dark mode, increased contrast, and reduced transparency.

**Acceptance criteria**

- No component uses a raw accent color outside the semantic token layer.
- Text and controls meet WCAG AA contrast.
- Selection, privacy, success, and destructive states are distinguishable without relying only on hue.

## IV-002 — Raise the typography floor and formalize the type scale

**Priority:** P0  
**Area:** Typography and readability

**Issue**

Many functional labels and explanations render at 7–10 px. They become illegible at normal desktop distance and weaken hierarchy. The app correctly uses a system stack in places, but the Windows-first `Segoe UI` order and ad-hoc weights/tracking make the macOS presentation feel less native.

**Fix**

- Use `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, `system-ui` on macOS, retaining Segoe fallbacks for Windows.
- Create a small type scale: 34/40 display, 28/34 title, 17/22 section title, 13/18 body, 12/16 secondary, 11/14 metadata (absolute minimum).
- Apply negative tracking only to display/title sizes; keep body near zero and add slight positive tracking only to uppercase metadata.
- Replace ultra-light secondary text with sufficient contrast and weight.
- Let layout spacing scale with text using `rem` where practical.

**Acceptance criteria**

- No essential text is below 11 px.
- No body/explanatory text is below 12 px.
- 125% and 150% text scaling do not clip controls or labels.

## IV-003 — Simplify the Home page into a single obvious first-run path

**Priority:** P0  
**Area:** Home / onboarding

**Issue**

The home page asks the user to parse a page header, hero, shortcut card, try/clear controls, latest-test field, three usage cards, setup panel, and three engine cards. The actual first-run requirement—download the model and grant permissions—competes with the demo and marketing content.

**Fix**

- Make the first-run state task-led: `1. Download model`, `2. Allow microphone`, `3. Allow typing`, with one clear primary action at a time.
- Once setup is complete, collapse onboarding into a compact status row and promote the dictation demo.
- Replace “Ready when you are” + “Turn a thought into finished text” duplication with one title and one concise supporting sentence.
- Move engine detail to Privacy/Audio; keep only a compact “Local Whisper · Ready” status on Home.
- Keep the value proposition direct and product-specific, borrowing Wispr Flow's clarity without copying its visual identity.

**Acceptance criteria**

- A new user can identify the next required action in under five seconds.
- Home has one primary action in every setup state.
- Completed setup reduces, rather than permanently occupying, vertical space.

## IV-004 — Replace decorative navigation glyphs with a coherent icon system

**Priority:** P1  
**Area:** Sidebar / navigation

**Issue**

The sidebar uses text glyphs (`⌂`, `◐`, `▰`, `↗`, `◇`, `Aa`, `◉`) with inconsistent visual weight, baseline, and meaning. The blue rounded icon tile appears only on the selected row, causing layout and weight changes between states.

**Fix**

- Use a single 16 px outline icon family with consistent stroke, optical size, and bounding box.
- Keep icon containers structurally identical in all states; selection should change fill/tint without changing geometry.
- Rename vague `Home` to `Dictation` if it remains the working surface; keep labels content-specific.
- Add visible keyboard focus and preserve native sidebar selection semantics.

**Acceptance criteria**

- Every navigation icon aligns to the same 16×16 optical box.
- Selected and unselected rows do not shift.
- Navigation remains understandable with icons hidden.

## IV-005 — Make motion physical, restrained, and interruptible

**Priority:** P0  
**Area:** Global motion / floating pill

**Issue**

Page changes use a generic entrance animation, while the pill relies on fixed CSS transitions and looping keyframes. The pill's width/height animation cannot inherit velocity or retarget smoothly; success uses an overshooting pop even when no momentum caused it. Several looping effects add activity without conveying progress.

**Fix**

- Remove page-wide translate/scale entrances; use a short 160–200 ms opacity transition only where it aids continuity.
- Model pill states with interruptible springs starting from the current presentation value (`response 0.3–0.4`, critically damped by default).
- Use no overshoot for status changes; reserve slight bounce for a momentum-driven gesture only.
- Keep audio bars driven by real input level; stop decorative breathing when no signal exists.
- Maintain symmetric paths and immediate press feedback; never disable input solely because an animation is running.
- Preserve reduced-motion cross-fades and reduced-transparency solid surfaces.

**Acceptance criteria**

- Rapidly switching pill states produces no jump or queued animation.
- All essential feedback appears on pointer-down or within one frame of the state change.
- Reduced-motion mode contains no translate, scale, spring, or looping animation.

## IV-006 — Reduce card chrome and strengthen page hierarchy

**Priority:** P1  
**Area:** Layout / information architecture

**Issue**

Nearly every group is placed inside a rounded bordered card. On Statistics, Providers, Privacy, and Appearance this creates “boxes within boxes,” making all sections feel equally important and increasing visual noise.

**Fix**

- Reserve elevated cards for independent, actionable objects or previews.
- Use section spacing, headings, and hairline separators for settings groups.
- Standardize a 12-column content grid, 24 px page rhythm, and 16 px internal group rhythm.
- Keep page titles and primary actions on a stable shared baseline across all pages.
- Use translucent material only for floating/sticky chrome, not every content container.

**Acceptance criteria**

- Each page has one dominant region and no more than two visual elevation levels.
- Shared headings, fields, and action rows align across pages.
- Removing borders does not reduce grouping clarity.

## IV-007 — Replace the cassette metaphor with a focused recording inspector

**Priority:** P1  
**Area:** History

**Issue**

The cassette is beautifully crafted but consumes most of the page, introduces tiny labels and decorative mechanics, and competes with the user's actual goals: find a recording, play it, read/copy text, and delete it. It also visually diverges from the otherwise modern system language.

**Fix**

- Use a two-pane recording browser: searchable/filterable list on the left, transcript and compact audio player on the right.
- Use a waveform/timeline with elapsed/remaining time and standard playback controls.
- Make empty state compact and instructional; do not render a large disabled player before a recording exists.
- Keep the local-storage promise visible but secondary.
- Preserve delight through subtle live waveform motion and tactile transport feedback, not skeuomorphic bulk.

**Acceptance criteria**

- The transcript is visible above the fold when a recording is selected.
- Empty History uses less than half of the content height.
- Playback controls have at least 44×44 px targets and accessible labels.

## IV-008 — Turn Appearance into guided presets with safe advanced controls

**Priority:** P1  
**Area:** Appearance

**Issue**

Appearance exposes nine positions, multiple continuous sliders, content modes, and eight raw colors at once. It offers flexibility but little protection against unreadable combinations, and the page becomes a dense configuration surface.

**Fix**

- Lead with three curated presets: `System`, `Graphite`, and `High Contrast`.
- Keep Position and Content as the primary controls; move color-level tuning into an `Advanced` disclosure.
- Show live contrast validation and prevent saving combinations that make text/status illegible.
- Replace the nine identical position cells with a miniature screen map and a clearly moving pill.
- Add a true `Use system appearance` option and clarify what changes affect only the pill.

**Acceptance criteria**

- A user can choose a polished appearance in one click.
- Advanced colors always show contrast status for text, live, success, and error states.
- Reset clearly states what will be restored and supports undo.

## IV-009 — Reframe Providers and Statistics around user decisions

**Priority:** P1  
**Area:** Providers / Statistics

**Issue**

Providers leads with a large editable system prompt, and Statistics exposes token pricing before users have any activity. These are technically transparent but cognitively heavy, especially for non-technical users.

**Fix**

- Providers: show provider choice, privacy route, model, connection state, and a simple cleanup-strength/style control first.
- Move the raw cleanup prompt into an `Advanced` editor with restore, preview, and validation.
- Statistics: emphasize dictation time, words, time saved, and recent trend; hide API-cost configuration until a cloud provider has usage.
- Explain estimates in plain language and separate measured values from estimates visually.

**Acceptance criteria**

- The common provider setup path requires no prompt editing.
- Advanced settings are one level deep and retain their current power.
- Empty Statistics explains what will appear after the first dictation without showing irrelevant configuration first.

## IV-010 — Improve control affordance, focus, and touch/pointer targets

**Priority:** P0  
**Area:** Accessibility / interaction

**Issue**

Several segmented controls, icon buttons, sliders, cassette controls, and text actions are below Apple's comfortable target size. Focus visibility is inconsistent, disabled text is very faint, and some state is communicated primarily through color.

**Fix**

- Make primary controls at least 44 px tall and compact desktop controls at least 32 px tall with a 44 px effective hit region where possible.
- Add a shared `:focus-visible` ring token with adequate contrast and non-color geometry.
- Pair status color with icon and text; keep disabled labels readable.
- Ensure segmented controls use proper radio/tab semantics and announce the selected option.
- Validate keyboard navigation order, Escape behavior in dialogs, and screen-reader names.

**Acceptance criteria**

- All interactive controls are reachable and operable by keyboard.
- Focus is always visible.
- Automated accessibility checks report no critical violations, followed by a manual VoiceOver pass.

## IV-011 — Tighten product copy and status language

**Priority:** P1  
**Area:** Content design

**Issue**

Copy alternates between marketing language, implementation language, and terse labels. Examples include “Private voice workspace,” “Processing,” “Capability check only,” “One-time setup,” and “Enable typing.” Several screens repeat the local/privacy claim without advancing the task.

**Fix**

- Use short, direct, action-led language: `Download Whisper`, `Allow Microphone`, `Allow Accessibility`, `Local Whisper is ready`.
- Replace implementation wording with user outcomes, while retaining technical detail behind `Learn more` or status disclosure.
- Use one consistent privacy statement and contextual detail only where data crosses a boundary.
- Standardize status verbs: `Ready`, `Listening`, `Transcribing`, `Cleaning`, `Inserted`, `Couldn't transcribe`.
- Remove unnecessary title punctuation and duplicate taglines.

**Acceptance criteria**

- Every button begins with a clear verb or names the resulting state.
- Status text tells the user what is happening and, on error, what to do next.
- Repeated privacy claims are consolidated without reducing transparency.

## IV-012 — Add visual regression and multi-state design QA

**Priority:** P1  
**Area:** Quality / responsiveness

**Issue**

The interface has many combinations: light/dark, seven pages, empty/populated states, setup permissions, multiple pill states, user-selected colors, narrow widths, and accessibility preferences. Manual inspection alone will miss regressions.

**Fix**

- Define canonical snapshots for each page at 1280×720 and a compact-width layout.
- Add states for first run, fully configured, empty/populated History, provider disconnected/connected/error, and every pill state.
- Include dark/light, increased contrast, reduced motion, and reduced transparency runs.
- Add a motion QA checklist for interruption, reversal, and rapid state changes.

**Acceptance criteria**

- Every ticket that changes UI updates or confirms relevant snapshots.
- CI catches unintended layout shifts and contrast regressions.
- Motion checks cover rapid state changes, not only final resting frames.

## Review addendum — binding implementation decisions

These decisions refine the tickets above and take precedence where wording conflicts:

- **Order:** IV-011 terminology → IV-001 cascade/tokens → IV-002 type → IV-010 accessibility → IV-003 Dictation setup → IV-005 pill motion → remaining pages → IV-012 QA.
- **Cascade:** consolidate the successive style/theme blocks before styling. Use one semantic token layer plus dark/contrast overrides; do not append another override layer. User colors stay scoped to `--pill-*`.
- **Type:** page title 32/38 (28/34 compact), section 17/22, body/control 13/18, secondary/data 12/16, metadata 11/14 minimum. Use supported 400/500/600/700 weights and tabular numerals for time/cost.
- **Palette:** separate semantic tokens for tint, local, live, success, warning, destructive, and focus even if some initial values coincide. Status always includes icon/text, not hue alone.
- **Home terminology:** canonical steps are `Download Whisper`, `Allow Microphone`, and `Allow Text Insertion`; explain that macOS manages insertion under Accessibility. Test blocked, downloading, denied, ready, and revoked states.
- **Navigation:** use 16×16 SVG icons with 1.5 px strokes in stable 24×24 containers; selection belongs to the entire 44 px row. Rename Home only after IV-003 confirms the page is truly the Dictation surface.
- **Motion:** the noninteractive pill has no gesture momentum, so container geometry uses a zero-bounce, critically damped, retargetable transition; content cross-fades in 120–160 ms. Success/error do not scale or rotate. At zero input, bars do not oscillate. Reduced motion uses opacity/static replacement only.
- **Overlay sizing:** the current 300×72 native window cannot contain the allowed 286 px pill at 150% scale. Dynamically fit and reposition the native window, or constrain scale/dimensions so every legal state remains unclipped.
- **Layout:** use an 8 px spacing base, 1080–1120 px maximum content width, 32 px desktop/20 px compact gutters, and responsive `minmax` splits. Ordinary content uses canvas plus one content-surface level; higher elevation is transient.
- **History:** transcript is primary. If retention is disabled, say `Recording history is off` and link to settings; never promise that dictating will create a saved recording. Search may wait until collection scale justifies it.
- **Appearance:** System follows OS appearance; Graphite and High Contrast are explicit presets; any advanced change becomes Custom. Require 4.5:1 text and 3:1 non-text contrast on representative light, dark, and busy backgrounds, with `Fix automatically`.
- **Split IV-009:** Providers is **IV-009A/P0** and must clearly distinguish Off, Local, and Cloud plus the exact text destination. Statistics is **IV-009B/P1**; show measured data before estimates and do not promise trends until timestamped storage exists.
- **Glossary/statuses:** Dictation, Whisper, on this computer, Microphone Access, Text Insertion, Text Cleanup, Recordings, Transcripts. States: Ready, Listening, Transcribing, Improving text, Inserting, Inserted, Couldn't hear speech, Couldn't transcribe, Couldn't insert text.
- **Accessibility:** compact visible controls are at least 32 px; 44 px effective targets must not overlap. Focus indicators have ≥3:1 adjacent contrast. Test keyboard semantics, dialog trap/Escape/return focus, sliders, 200% text reflow, disabled contrast, custom palettes, and packaged-app VoiceOver behavior.
- **QA:** use deterministic state fixtures, sample intermediate motion frames, assert accessibility media preferences, and snapshot the separate overlay across all states/content modes/scale extremes.
