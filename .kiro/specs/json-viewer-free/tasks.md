# Implementation Plan: Json Viewer Free

## Overview

This plan builds Json Viewer Free as a 100% client-side TypeScript application on the existing AstroJS project in `dangerous-disk/`. Work proceeds bottom-up: first the pure, fully-testable `json-core` library (model, parse/serialize, canonicalization, paths, diff/patch/merge, fixer, rich-media, grid, share, converters, codegen, query), then the Web Worker layer and shared state, then the editor and four tool panels, then the Astro shell/navigation/design tokens, and finally sharing, keyboard, privacy, and performance wiring.

Property-based tests (fast-check + @fast-check/vitest, ≥100 iterations, tagged `Feature: json-viewer-free, Property N`) are placed next to the pure functions they validate so correctness is caught early. Each property test references the design property number and the requirement clauses it validates. All paths are under `dangerous-disk/src`.

## Tasks

- [x] 1. Project setup and build tooling
  - [x] 1.1 Install dependencies and configure Astro/Tailwind/Monaco/Vitest
    - Add and pin dependencies in `dangerous-disk/package.json`: `monaco-editor`, `lossless-json`, `fast-json-patch`, `fast-xml-parser`, `papaparse`, `quicktype-core`, `jsonpath-plus` (>=10.3.0), `jmespath`, `@tanstack/virtual-core`, `fflate`, `preact`, `@astrojs/preact`, `nanostores`, `@nanostores/preact`, `tailwindcss`, `@tailwindcss/vite`, and dev deps `fast-check`, `@fast-check/vitest`, `vitest`, `jsdom` (reuse already-present `jsonc-parser`, `js-yaml`, `smol-toml`)
    - Update `dangerous-disk/astro.config.mjs`: `output: 'static'`, add `@astrojs/preact` integration, add `@tailwindcss/vite`, and configure Vite so Monaco JSON/editor language workers emit as same-origin worker chunks via `self.MonacoEnvironment.getWorker`
    - Create `dangerous-disk/vitest.config.ts` with the `jsdom` environment and wire `@fast-check/vitest`
    - _Requirements: 17.1, 22.2, 22.7_

  - [x] 1.2 Create Tailwind 4 `@theme` design tokens
    - Create `dangerous-disk/src/styles/theme.css` importing `tailwindcss` and defining the `@theme` color, type-badge color, typography, radius, and spacing tokens mapped from `DESIGN.md`, plus the Level 1–5 elevation shadow utilities
    - Ensure all six type-badge colors and the canvas/ink/body/mute/hairline tokens are present so no hardcoded values are needed downstream
    - _Requirements: 22.1_

  - [x] 1.3 Write design-token contrast test
    - **Property 35: Design token contrast meets WCAG AA**
    - **Validates: Requirements 22.6**
    - Compute the contrast ratio for every text-on-surface token pair used by the UI; assert ≥4.5:1 for normal text and ≥3:1 for large text and interactive boundaries

- [x] 2. json-core model, parsing, serialization, and canonicalization
  - [x] 2.1 Define the JsonNode data model and conversions
    - Create `dangerous-disk/src/lib/json-core/types.ts` and `model.ts` with `JsonType`, `JsonNode` (ordered `children`, raw `numberValue` lexeme), and `fromLossless`/`toLossless` converters that preserve object key order, array order, and numeric precision
    - _Requirements: 1.1, 20.6_

  - [x] 2.2 Implement canonicalization and structural equality
    - Create `dangerous-disk/src/lib/json-core/canonical.ts` with `canonicalize` (recursively key-sorted, number-lexeme normalized) and `structuralEquals` used as the oracle for all equivalence checks
    - _Requirements: 8.7_

  - [x] 2.3 Create fast-check arbitraries and equality oracle harness
    - Create `dangerous-disk/src/test/arbitraries.ts` exporting `jsonArbitrary` (nested objects/arrays, edge-y strings, integers/floats/large-int/high-precision lexemes) and derived arbitraries (`arrayOfUniformObjectsArbitrary`, `imageUrlArbitrary`, `hexColorArbitrary`, `timestampArbitrary`, `deformedJsonArbitrary`, `editOperationArbitrary`) plus a re-export of `structuralEquals`
    - _Requirements: 2.8, 8.7_

  - [x] 2.4 Implement parseJson with lossless parsing and error location
    - Create `dangerous-disk/src/lib/json-core/parse.ts`: parse with `lossless-json` into a `JsonNode` model; on syntax error use `jsonc-parser` to report error type with 1-based line/column; treat empty/whitespace-only input as valid-empty
    - _Requirements: 1.1, 6.4_

  - [x] 2.5 Write validator first-error property test
    - **Property 14: Validator reports the first error at the correct 1-based position**
    - **Validates: Requirements 6.4**

  - [x] 2.6 Implement serialize, format, and minify
    - Create `dangerous-disk/src/lib/json-core/serialize.ts`: `format(model, style)` for 2-space/4-space/tab indentation with one space after each name-value separator, `serialize(model)`, and string-literal-aware `minify(text)`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 2.7 Write round-trip and indentation property tests
    - **Property 1: Parse/serialize round-trip preserves the model** — Validates: Requirements 2.8, 5.5
    - **Property 2: Format and minify round-trips preserve the model** — Validates: Requirements 5.5, 5.6
    - **Property 3: Formatting produces correct indentation structure** — Validates: Requirements 5.1, 5.2, 5.3, 5.4

- [x] 3. JSON path computation
  - [x] 3.1 Implement dot-notation, bracket-notation, and path resolution
    - Create `dangerous-disk/src/lib/json-core/path.ts`: `dotPath` (with the ASCII-identifier escaping rule), `bracketPath` (bracketed integers and quoted-string keys), and `resolvePath`
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 3.2 Write path-correctness and escaping property tests
    - **Property 8: Path-correctness for both notations** — Validates: Requirements 4.1, 4.2, 4.6
    - **Property 9: Dot-path key escaping rule** — Validates: Requirements 4.5

- [x] 4. Diff, patch, and three-way merge
  - [x] 4.1 Implement semantic diff
    - Create `dangerous-disk/src/lib/json-core/diff.ts`: `semanticDiff(left, right)` returning path-keyed `Difference[]` classified as addition/deletion/modification, built on `canonicalize`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 4.2 Write diff property tests
    - **Property 15: Diff soundness** — Validates: Requirements 8.7
    - **Property 16: Diff invariance under key reordering and reformatting** — Validates: Requirements 8.2, 8.3
    - **Property 17: Diff classifies each change correctly** — Validates: Requirements 8.1, 8.4, 8.5, 8.6

  - [x] 4.3 Implement RFC 6902 JSON Patch generation
    - Create `dangerous-disk/src/lib/json-core/patch.ts`: `toJsonPatch(left, right)` using `fast-json-patch.compare()`, returning the empty array for structurally equivalent inputs
    - _Requirements: 10.1, 10.3_

  - [x] 4.4 Write JSON Patch property tests
    - **Property 18: JSON Patch conformance** — Validates: Requirements 10.1
    - **Property 19: Patch-correctness** — Validates: Requirements 10.2, 10.3

  - [x] 4.5 Implement three-way merge
    - Create `dangerous-disk/src/lib/json-core/merge.ts`: `threeWayMerge(base, left, right)` applying non-conflicting changes, marking conflicts with base/left/right values, and supporting conflict resolution by chosen side
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 4.6 Write three-way merge property tests
    - **Property 20: Three-way merge applies all non-conflicting changes** — Validates: Requirements 11.1, 11.2, 11.3, 11.4
    - **Property 21: Three-way merge detects and resolves conflicts** — Validates: Requirements 11.5, 11.6

- [x] 5. Smart Fixer
  - [x] 5.1 Implement smartFix
    - Create `dangerous-disk/src/lib/json-core/fixer.ts`: remove trailing commas, quote unquoted keys, replace single-quote delimiters (handling multiple categories per activation), return corrected valid JSON with a per-category correction summary, or first remaining-error line/column on failure
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8_

  - [x] 5.2 Write Smart Fixer property tests
    - **Property 12: Smart Fixer always yields valid JSON equal to the intended document** — Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.8
    - **Property 13: Smart Fixer correction summary counts are accurate** — Validates: Requirements 7.6

- [x] 6. Rich-media, grid, and share-link cores
  - [x] 6.1 Implement rich-media classification
    - Create `dangerous-disk/src/lib/json-core/richmedia.ts`: classify strings as image URL / hex color / non-image link and numbers in [0, 4102444800] as Unix timestamps with ISO 8601 rendering; non-matching values get no classification
    - _Requirements: 12.1, 12.3, 12.4, 12.5_

  - [x] 6.2 Write rich-media classification property test
    - **Property 22: Rich-media classification is correct per value space**
    - **Validates: Requirements 12.1, 12.3, 12.4, 12.5**

  - [x] 6.3 Implement grid transforms
    - Create `dangerous-disk/src/lib/json-core/grid.ts`: `toGrid` (columns by first appearance, rows in array order, empty cells for missing keys), `filterRows` (case-insensitive substring global search + per-column filter, empty cells non-matching), and `sortRows` (ascending/descending toggle)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 6.4 Write grid property tests
    - **Property 26: Grid construction mirrors the array** — Validates: Requirements 15.1, 15.6
    - **Property 27: Grid search and filter select exactly the matching rows** — Validates: Requirements 15.2, 15.3, 15.4, 15.6
    - **Property 28: Grid sort orders ascending then toggles to descending** — Validates: Requirements 15.5

  - [x] 6.5 Implement share-link encode/decode
    - Create `dangerous-disk/src/lib/json-core/share.ts`: `encodeShare` (reject invalid/empty JSON; DEFLATE via `fflate`, base64url, version + tool prefix; reject if >2,000,000 chars) and `decodeShare` (reverse and validate it parses as JSON)
    - _Requirements: 20.1, 20.2, 20.3, 20.7_

  - [x] 6.6 Write share-link round-trip property test
    - **Property 30: Share-link round-trip preserves the payload exactly**
    - **Validates: Requirements 20.1, 20.5, 20.6**

- [x] 7. Converters, code generation, and query engine
  - [x] 7.1 Implement YAML and TOML converters
    - Create `dangerous-disk/src/lib/converters/yaml.ts` (`js-yaml`) and `toml.ts` (`smol-toml`) for both-way conversion preserving keys, values, nesting, and types
    - _Requirements: 13.1, 13.5, 13.6_

  - [x] 7.2 Write YAML and TOML round-trip property tests
    - **Property 23: YAML round-trip** — Validates: Requirements 13.1, 13.6, 13.7
    - **Property 24: TOML round-trip** — Validates: Requirements 13.5, 13.6, 13.8

  - [x] 7.3 Implement XML and CSV converters
    - Create `dangerous-disk/src/lib/converters/xml.ts` (`fast-xml-parser`, single root element) and `csv.ts` (`papaparse`); CSV rejects non-array-of-objects and non-uniform keys with a descriptive error and no partial output
    - _Requirements: 13.2, 13.3, 13.4, 13.6_

  - [x] 7.4 Write XML/CSV round-trip property test and CSV error unit tests
    - **Property 25: XML and CSV structure preservation round-trips** — Validates: Requirements 13.2, 13.3, 13.6
    - Add unit tests for the CSV not-convertible error path (no partial output) — Validates: Requirements 13.4

  - [x] 7.5 Implement code generation
    - Create `dangerous-disk/src/lib/codegen/quicktype.ts` wrapping `quicktype-core` to emit TypeScript, Java, Go, Python, and Dart definitions from a JSON sample
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 7.6 Write code generation unit tests
    - Assert each language target emits syntactically valid, distinct named definitions; assert empty/invalid input surfaces the validation error state
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.8_

  - [x] 7.7 Implement query engine
    - Create `dangerous-disk/src/lib/query/engine.ts` wrapping `jsonpath-plus` (no eval-enabling options) and `jmespath`; return typed syntax errors with character position and an empty-expression guard
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.6_

  - [x] 7.8 Write query property test and invalid-expression unit tests
    - **Property 29: Query evaluation returns the targeted nodes** — Validates: Requirements 16.1, 16.2
    - Add unit tests for invalid-expression and empty-expression error paths — Validates: Requirements 16.3, 16.6

- [x] 8. Checkpoint - json-core complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Web Worker layer
  - [x] 9.1 Implement worker protocol and client
    - Create `dangerous-disk/src/lib/workers/worker-protocol.ts` (tagged `{ jobId, op, payload }` requests; `result`/`error`/`progress` responses) and `worker-client.ts` (promise-per-jobId, ≥1/sec progress relay, cancellation of superseded jobs)
    - _Requirements: 17.1, 17.2, 17.3, 17.5_

  - [x] 9.2 Implement worker entrypoints
    - Create `parse.worker.ts`, `diff.worker.ts`, `convert.worker.ts`, `codegen.worker.ts`, `query.worker.ts` under `dangerous-disk/src/lib/workers/` that call the shared `json-core`/converter/codegen/query functions and emit progress + a single terminal message
    - _Requirements: 17.1, 17.4_

  - [x] 9.3 Write worker dispatch integration tests
    - Verify job dispatch resolves, progress fires at least once per second for long jobs, superseded jobs are cancelled, and failures reject with a reason
    - _Requirements: 17.2, 17.3, 17.4, 17.5_

- [x] 10. Shared state stores
  - [x] 10.1 Implement nanostores document and UI stores
    - Create `dangerous-disk/src/lib/stores/document.ts` with `$document` (text + parsed model), `$activeTool`, and `$settings`
    - _Requirements: 21.5, 21.6_

  - [x] 10.2 Write document store unit tests
    - Verify the shared document text is retained byte-for-byte across tool changes and settings updates
    - _Requirements: 21.5, 21.6_

- [x] 11. Application shell, layout, and navigation
  - [x] 11.1 Create static layout and homepage
    - Create `dangerous-disk/src/layouts/Layout.astro` (imports `theme.css`, fonts) and `dangerous-disk/src/pages/index.astro` with the hero band and the always-visible privacy statement, mounting `<AppShell client:load />`, rendered ad-free
    - _Requirements: 18.3, 22.2_

  - [x] 11.2 Implement AppShell island and client-side tool router
    - Create `dangerous-disk/src/components/app/AppShell.tsx`: client-side panel router that swaps the four tool panels in-memory (<500 ms), mirrors active tool to the `#tool=` hash, and preserves the shared `$document`
    - _Requirements: 21.2, 21.5, 21.6_

  - [x] 11.3 Write tool-switching property test
    - **Property 34: Tool switching preserves the shared document**
    - **Validates: Requirements 21.5, 21.6**

  - [x] 11.4 Implement NavigationBar with active state and responsive layout
    - Create `dangerous-disk/src/components/app/NavigationBar.tsx`: exactly four labeled entries, single active-state indicator, collapsed mobile layout below 960px (single toggle) and full horizontal layout at ≥960px
    - _Requirements: 21.1, 21.3, 21.4, 22.3, 22.4, 22.5_

  - [x] 11.5 Write navigation property test and responsive unit tests
    - **Property 33: Navigation has a single active tool** — Validates: Requirements 21.3, 21.4
    - Add unit tests for the <600px, 600–959px, and ≥960px breakpoint layouts — Validates: Requirements 22.3, 22.4, 22.5

- [x] 12. Editor and validation status
  - [x] 12.1 Implement EditorPane
    - Create `dangerous-disk/src/components/app/EditorPane.tsx`: Monaco wrapper (imported only client-side) with 300 ms debounced validation that sets an inline marker at the first error's line/column and clears markers when content becomes valid
    - _Requirements: 6.1, 6.4, 6.5, 6.6_

  - [x] 12.2 Implement StatusBar
    - Create `dangerous-disk/src/components/app/StatusBar.tsx`: distinct valid/error indicators, document size, and worker progress indicator; empty/whitespace shows the valid indicator
    - _Requirements: 6.2, 6.3, 17.3_

  - [x] 12.3 Write editor validation unit tests
    - Verify valid/error/empty indicator states, first-error marker placement, and marker clearing on invalid→valid transition
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 13. Viewer tool panel
  - [x] 13.1 Implement TreePanel virtualized tree model
    - Create `dangerous-disk/src/components/viewer/TreePanel.tsx`: derive a flattened windowed row list from the `JsonNode` tree plus an `expandedIds` set (root expanded, others collapsed); support expand/collapse, expand-all, collapse-all; use `@tanstack/virtual-core`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.8_

  - [x] 13.2 Write tree structure and expansion property tests
    - **Property 4: Tree structure and child counts mirror the document** — Validates: Requirements 1.1, 1.6, 1.9
    - **Property 5: Expansion state transitions are well-defined** — Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.8

  - [x] 13.3 Implement TypeBadge
    - Create `dangerous-disk/src/components/viewer/TypeBadge.tsx`: exactly one token-colored, distinctly-labeled badge per type for the six types plus an unknown (`?`) badge
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 13.4 Write type-badge property tests and unknown-type unit test
    - **Property 6: Exactly one type badge matches each node's type** — Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
    - **Property 7: Type badges are mutually distinct** — Validates: Requirements 3.7
    - Add a unit test for the unknown-type fallback badge — Validates: Requirements 3.8

  - [x] 13.5 Implement TreeRow with node editing and path copy
    - Create `dangerous-disk/src/components/viewer/TreeRow.tsx`: render badge/key/value with child counts; support add-key, delete, rename-key, edit-scalar with duplicate-key and invalid-scalar rejection plus error messaging; copy dot/bracket path to clipboard with confirmation and copy-failure handling
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 1.6, 4.1, 4.2, 4.3, 4.4_

  - [x] 13.6 Write node-edit property tests and clipboard unit tests
    - **Property 10: Node edits round-trip through the editor text** — Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.8
    - **Property 11: Invalid node edits are rejected without side effects** — Validates: Requirements 2.5, 2.6, 2.7
    - Add unit tests for path-copy confirmation timing and copy-failure handling — Validates: Requirements 4.3, 4.4

  - [x] 13.7 Implement RichMedia component
    - Create `dangerous-disk/src/components/viewer/RichMedia.tsx`: image hover thumbnail (≤200×200, 300 ms delay), hex color swatch, timestamp ISO annotation, activatable links opening a new tab, and a disable-all-inference mode
    - _Requirements: 12.1, 12.2, 12.5, 12.6_

  - [x] 13.8 Write RichMedia rendering unit tests
    - Verify image load-failure fallback to a link with a "could not load" indication and that disabled mode renders plain text only
    - _Requirements: 12.2, 12.6_

  - [x] 13.9 Assemble Viewer panel
    - Create `dangerous-disk/src/components/viewer/ViewerPanel.tsx` wiring EditorPane + TreePanel + StatusBar + RichMedia, including collapse-all/expand-all controls and the validation error state when content is invalid
    - _Requirements: 1.4, 1.5, 1.7_

- [x] 14. Diff Checker tool panel
  - [x] 14.1 Implement DiffPanel
    - Create `dangerous-disk/src/components/diff/DiffPanel.tsx`: Monaco `IStandaloneDiffEditor` with side-by-side and unified toggling, distinct addition/deletion/modification styles, a no-differences message, and a per-document load-error message that retains prior results
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 14.2 Implement SemanticDiffList
    - Create `dangerous-disk/src/components/diff/SemanticDiffList.tsx`: render path-keyed add/del/mod entries from `semanticDiff`; show the validation error state for an invalid document
    - _Requirements: 8.1, 8.8_

  - [x] 14.3 Implement PatchExport
    - Create `dangerous-disk/src/components/diff/PatchExport.tsx`: render the RFC 6902 patch with a copy control, confirmation indication, and copy-failure handling that retains the patch
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 14.4 Implement MergePanel
    - Create `dangerous-disk/src/components/diff/MergePanel.tsx`: base/left/right inputs, conflict presentation and resolution, export gating with unresolved-conflict count, and the validation error state for invalid documents
    - _Requirements: 11.5, 11.6, 11.7, 11.8, 11.9_

  - [x] 14.5 Write diff/merge/patch UI unit tests
    - Verify the no-differences message, conflict-count export gating, and patch copy confirmation/failure indications
    - _Requirements: 9.6, 11.7, 10.5, 10.6_

- [x] 15. Table Grid tool panel
  - [x] 15.1 Implement GridPanel
    - Create `dangerous-disk/src/components/grid/GridPanel.tsx`: virtualized table over `toGrid`/`filterRows`/`sortRows` with search input, per-column filter, ascending/descending sort toggle, empty-cell handling, a no-matching-rows message that retains headers, and a not-an-array-of-objects message
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 15.2 Write grid UI unit tests
    - Verify the no-matching-rows message retains headers and the not-an-array-of-objects message renders no rows
    - _Requirements: 15.7, 15.8_

- [x] 16. Converter tool panel
  - [x] 16.1 Implement ConvertPanel
    - Create `dangerous-disk/src/components/convert/ConvertPanel.tsx`: JSON↔YAML/XML/CSV/TOML both ways via workers, with descriptive errors (line/path where determinable) that leave the source unchanged
    - _Requirements: 13.4, 13.9, 13.10_

  - [x] 16.2 Implement CodeGenPanel
    - Create `dangerous-disk/src/components/convert/CodeGenPanel.tsx`: TS/Java/Go/Python/Dart selection, copy-to-clipboard with confirmation/failure handling, and the validation error state for empty/invalid input
    - _Requirements: 14.6, 14.7, 14.8, 14.9_

  - [x] 16.3 Implement QueryPanel
    - Create `dangerous-disk/src/components/convert/QueryPanel.tsx`: JSONPath/JMESPath mode selection, results display with a no-results indicator, copy-to-clipboard with confirmation/failure handling
    - _Requirements: 16.4, 16.5, 16.7_

- [x] 17. Checkpoint - all tool panels functional
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Keyboard, sharing, and privacy
  - [x] 18.1 Implement keyboard shortcuts and reference overlay
    - Create `dangerous-disk/src/lib/keyboard/shortcuts.ts` (registry) and `dangerous-disk/src/components/app/ShortcutHelp.tsx`; wire a global key manager in AppShell for format, clear (no-op when empty), collapse-all, tab-switch (with visible focus), and the shortcuts reference, responding regardless of focused element
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7_

  - [x] 18.2 Write keyboard property tests
    - **Property 31: Clear shortcut empties the editor** — Validates: Requirements 19.2
    - **Property 32: Shortcut reference lists every shortcut** — Validates: Requirements 19.7

  - [x] 18.3 Wire Share-Link manager into AppShell
    - Add a share manager to `AppShell.tsx`: on request encode via `encodeShare` and copy the link (with empty/invalid and too-large error messages, and manual-copy fallback on copy failure); on load decode the hash and populate editor + active tool, falling back to an empty editor with the prior tool on decode failure
    - _Requirements: 20.1, 20.2, 20.4, 20.5, 20.7_

  - [x] 18.4 Write share UI unit tests
    - Verify empty/invalid rejection, too-large rejection, copy-failure manual fallback, and decode-failure behavior
    - _Requirements: 20.2, 20.3, 20.4, 20.7_

  - [x] 18.5 Enforce client-side privacy
    - Keep `output: 'static'` (no backend) and add a Content-Security-Policy `connect-src 'self'` meta/header in `Layout.astro`/`astro.config.mjs` so no user JSON is transmitted; ensure all operations run locally and offline
    - _Requirements: 18.1, 18.2, 18.4, 18.5_

  - [x] 18.6 Write privacy integration tests
    - Use a network spy to assert no request carries user JSON, assert the CSP `connect-src 'self'`, and assert operations succeed with no network connection
    - _Requirements: 18.1, 18.2, 18.4, 18.5_

- [x] 19. Performance and final integration
  - [x] 19.1 Wire large-document worker dispatch into the tools
    - Route parsing of Large_Documents and all heavy operations (diff, patch, merge, convert, codegen, query) through the `WorkerClient` from the panels, keeping input responsive (<100 ms), showing the progress indicator, rendering results on completion, and restoring the prior view with a reason on failure
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 19.2 Write performance and smoke benchmark tests
    - Assert format/minify <3 s at 5 MB, conversion <2 s at 5 MB, query <2 s at 50 MB, TTI <3 s, ad-free DOM, and token-only styling
    - _Requirements: 5.9, 13.9, 16.1, 16.2, 22.2, 22.7_

  - [x] 19.3 Final wiring of the AppShell router
    - Mount ViewerPanel, DiffPanel/MergePanel, GridPanel, and ConvertPanel into the AppShell client-side router so navigation renders exactly one panel at a time and the shared document flows between Viewer/Grid/Converter
    - _Requirements: 21.1, 21.2_

- [x] 20. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references the specific requirement clauses it implements for traceability.
- Property tests target the pure `json-core` layer and are tagged `// Feature: json-viewer-free, Property N: ...`, run with `fast-check` + `@fast-check/vitest` at ≥100 iterations.
- Checkpoints (tasks 8, 17, 20) provide incremental validation points.
- All code lives under `dangerous-disk/src`; the project is a static, fully client-side export.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "2.4", "2.6"] },
    { "id": 2, "tasks": ["2.3", "3.1", "6.1", "6.3", "7.5", "7.7"] },
    { "id": 3, "tasks": ["2.5", "2.7", "3.2", "4.1", "4.3", "5.1", "6.2", "6.4", "6.5", "7.1", "7.3", "7.6", "7.8"] },
    { "id": 4, "tasks": ["4.2", "4.4", "4.5", "5.2", "6.6", "7.2", "7.4"] },
    { "id": 5, "tasks": ["4.6", "9.1", "10.1"] },
    { "id": 6, "tasks": ["9.2", "10.2", "11.1", "12.1", "12.2"] },
    { "id": 7, "tasks": ["9.3", "11.2", "11.4", "12.3"] },
    { "id": 8, "tasks": ["11.3", "11.5", "13.1", "13.3", "13.7"] },
    { "id": 9, "tasks": ["13.2", "13.4", "13.5", "13.8", "14.1", "14.2", "14.3", "14.4", "15.1", "16.1", "16.2", "16.3"] },
    { "id": 10, "tasks": ["13.6", "13.9", "14.5", "15.2", "18.1", "18.5"] },
    { "id": 11, "tasks": ["18.2", "18.3", "18.6", "19.1"] },
    { "id": 12, "tasks": ["18.4", "19.3"] },
    { "id": 13, "tasks": ["19.2"] }
  ]
}
```
