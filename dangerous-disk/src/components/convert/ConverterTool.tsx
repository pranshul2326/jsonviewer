/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 19.3
//
// ConverterTool — the composed Converter tool mounted by the AppShell router.
//
// It groups the three converter surfaces, all of which read the single shared
// `$document` store, into one cohesive tool with three sub-modes:
//
//   • "Convert" — JSON ⇄ YAML / XML / CSV / TOML (ConvertPanel, Req 13).
//   • "Code"    — TypeScript / Java / Go / Python / Dart generation
//                 (CodeGenPanel, Req 14).
//   • "Query"   — JSONPath / JMESPath evaluation (QueryPanel, Req 16).
//
// Because every sub-panel reads the shared `$document`, switching modes (and
// switching into the Converter tool from the Viewer/Grid) operates on the exact
// same document with no re-parsing (Req 21.5/21.6). All chrome derives from
// design tokens (Req 22.1).

import { useState } from 'preact/hooks';
import ConvertPanel from './ConvertPanel';
import CodeGenPanel from './CodeGenPanel';
import QueryPanel from './QueryPanel';

/** The three sub-modes of the Converter tool. */
type ConverterMode = 'convert' | 'code' | 'query';

/** Display metadata for each mode, in display order. */
const MODES: ReadonlyArray<{ id: ConverterMode; label: string }> = [
  { id: 'convert', label: 'Convert' },
  { id: 'code', label: 'Code' },
  { id: 'query', label: 'Query' },
] as const;

/** Shared base classes for the mode-toggle segmented control buttons. */
const TAB_BASE =
  'inline-flex items-center font-sans text-button-md rounded-md px-3 py-1.5 ' +
  'transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';
const TAB_ACTIVE = 'bg-canvas text-ink shadow-level-1';
const TAB_INACTIVE = 'text-body hover:text-ink';

/**
 * The composed Converter tool: a segmented mode control over the format
 * converter, the code generator, and the query evaluator, each operating on the
 * shared document.
 */
export default function ConverterTool() {
  const [mode, setMode] = useState<ConverterMode>('convert');

  return (
    <section
      aria-label="Converter panel"
      data-tool-panel="converter"
      class="flex min-h-0 flex-1 flex-col gap-md p-md"
    >
      {/* Sub-mode toggle: Convert / Code / Query. */}
      <div
        class="inline-flex items-center gap-1 self-start rounded-lg bg-canvas-soft-2 p-1"
        role="group"
        aria-label="Converter mode"
      >
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            class={`${TAB_BASE} ${mode === id ? TAB_ACTIVE : TAB_INACTIVE}`}
            aria-pressed={mode === id}
            data-mode={id}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        {mode === 'convert' ? (
          <ConvertPanel />
        ) : mode === 'code' ? (
          <CodeGenPanel />
        ) : (
          <QueryPanel />
        )}
      </div>
    </section>
  );
}
