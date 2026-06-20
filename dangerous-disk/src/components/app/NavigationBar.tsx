/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 11.4
//
// NavigationBar: the single top-level navigation that groups the four primary
// tools (Viewer, Diff Checker, Table Grid, Converter). It is a presentational
// Preact island that reads the shared `$activeTool` store and calls
// `setActiveTool` when an entry is selected.
//
// Behavior mapped to requirements:
//   • Req 21.1 — exactly four entries, each with a text label, one per Tool.
//   • Req 21.3 — selecting an entry sets it active and clears the others.
//   • Req 21.4 — exactly one entry carries the active-state indicator.
//   • Req 22.3/22.4 — below 960px (incl. the 600–959px band) the bar collapses
//                     to a single toggle control (hamburger) that opens a menu
//                     exposing the four entries.
//   • Req 22.5 — at ≥960px the bar is a full horizontal row with all four
//                entries visible and no toggle control.
//
// Styling derives entirely from the `nav-bar` / `nav-link` design tokens
// (canvas/ink/body colors, body-sm typography, 64px bar height, ghost-pill
// nav links) surfaced as Tailwind 4 utilities — no hardcoded values (Req 22.1).
// The 960px breakpoint is expressed with Tailwind arbitrary media variants
// (`min-[960px]:` / `max-[960px]:`) so the boundary matches the requirement
// exactly rather than the nearest default breakpoint.

import { useStore } from '@nanostores/preact';
import { useState } from 'preact/hooks';
import { $activeTool, setActiveTool, type Tool } from '../../lib/stores/document';

/** A single navigation entry: its Tool id and the visible text label (Req 21.1). */
interface NavEntry {
  tool: Tool;
  label: string;
}

/**
 * The exactly-four navigation entries, in display order, mapping each visible
 * label to its {@link Tool} value (Req 21.1).
 */
const NAV_ENTRIES: readonly NavEntry[] = [
  { tool: 'viewer', label: 'Viewer' },
  { tool: 'diff', label: 'Diff Checker' },
  { tool: 'grid', label: 'Table Grid' },
  { tool: 'converter', label: 'Converter' },
] as const;

/** Shared `nav-link` ghost-pill base classes (token-driven, body-sm). */
const NAV_LINK_BASE =
  'inline-flex items-center font-sans text-body-sm rounded-full ' +
  'px-3 py-2 transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';

/** Active nav-link: the single visible active-state indicator (Req 21.4). */
const NAV_LINK_ACTIVE = 'bg-canvas-soft-2 text-ink font-medium';

/** Inactive nav-link: muted body text with a ghost-pill on hover. */
const NAV_LINK_INACTIVE = 'text-body hover:bg-canvas-soft-2 hover:text-ink';

/**
 * Compose the class list for a nav entry based on whether it is the active tool.
 * Exactly one entry is active at a time, so exactly one entry receives
 * {@link NAV_LINK_ACTIVE} (Req 21.3, 21.4).
 */
function navLinkClass(isActive: boolean): string {
  return `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`;
}

/** Props for {@link NavigationBar}. */
export interface NavigationBarProps {
  /** Accessible label for the navigation landmark. */
  label?: string;
}

/**
 * Render the top navigation bar. Reads the active tool from `$activeTool` so the
 * active-state indicator stays in sync with the rest of the app, and writes via
 * `setActiveTool` on selection.
 */
export function NavigationBar({ label = 'Primary' }: NavigationBarProps) {
  const activeTool = useStore($activeTool);
  // Open/closed state for the collapsed mobile menu (<960px) only. The desktop
  // row never consults this — it is always visible at ≥960px.
  const [menuOpen, setMenuOpen] = useState(false);

  /** Select a tool, update shared state, and close the mobile menu. */
  const select = (tool: Tool) => {
    setActiveTool(tool);
    setMenuOpen(false);
  };

  return (
    <nav
      aria-label={label}
      class="relative flex h-16 items-center justify-between gap-3 border-b border-hairline bg-canvas px-6 py-3 text-ink"
    >
      {/* Brand wordmark (decorative; not one of the four tool entries). */}
      <span class="font-sans text-body-sm-strong text-ink select-none">JSON Viewer Free</span>

      {/* ── Full horizontal layout (≥960px): all four entries, no toggle (Req 22.5) ── */}
      <ul class="hidden min-[960px]:flex items-center gap-1" role="list">
        {NAV_ENTRIES.map((entry) => {
          const isActive = entry.tool === activeTool;
          return (
            <li key={entry.tool}>
              <button
                type="button"
                class={navLinkClass(isActive)}
                aria-current={isActive ? 'page' : undefined}
                data-active={isActive ? 'true' : 'false'}
                data-tool={entry.tool}
                onClick={() => select(entry.tool)}
              >
                {entry.label}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ── Collapsed mobile layout (<960px): single toggle control (Req 22.3, 22.4) ── */}
      <button
        type="button"
        class="inline-flex min-[960px]:hidden items-center justify-center rounded-full p-2 text-body transition-colors hover:bg-canvas-soft-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
        aria-label="Toggle navigation menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="nav-mobile-menu"
        data-toggle="nav-menu"
        onClick={() => setMenuOpen((open) => !open)}
      >
        {/* Hamburger / close glyph driven by open state. */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          {menuOpen ? (
            <>
              <line x1="5" y1="5" x2="15" y2="15" />
              <line x1="15" y1="5" x2="5" y2="15" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="17" y2="6" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="14" x2="17" y2="14" />
            </>
          )}
        </svg>
      </button>

      {/* Mobile menu panel: revealed by the toggle, hidden at ≥960px. */}
      {menuOpen && (
        <ul
          id="nav-mobile-menu"
          role="menu"
          class="min-[960px]:hidden absolute left-0 right-0 top-16 z-10 flex flex-col gap-1 border-b border-hairline bg-canvas p-3 shadow-level-5"
        >
          {NAV_ENTRIES.map((entry) => {
            const isActive = entry.tool === activeTool;
            return (
              <li key={entry.tool} role="none">
                <button
                  type="button"
                  role="menuitem"
                  class={`w-full justify-start ${navLinkClass(isActive)}`}
                  aria-current={isActive ? 'page' : undefined}
                  data-active={isActive ? 'true' : 'false'}
                  data-tool={entry.tool}
                  onClick={() => select(entry.tool)}
                >
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

export default NavigationBar;
