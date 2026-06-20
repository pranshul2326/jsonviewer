/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 18.1
//
// ShortcutHelp: the keyboard-shortcuts reference overlay (Req 19.7).
//
// It renders a modal dialog that lists EVERY entry in the shortcut registry
// (`SHORTCUTS`) together with its key hint and action description. Because the
// list is derived directly from the registry, the reference is guaranteed to
// stay complete as shortcuts are added or changed — the invariant the Task 18.2
// property test (Property 32) checks.
//
// Styling is entirely token-driven (canvas/ink/body/hairline colors, the
// Level-5 modal elevation, body-sm typography) so no hardcoded values are
// introduced (Req 22.1).

import { useEffect, useRef } from 'preact/hooks';
import {
  SHORTCUTS,
  formatCombo,
  detectPlatform,
  type PlatformInfo,
} from '../../lib/keyboard/shortcuts';

/** Props for {@link ShortcutHelp}. */
export interface ShortcutHelpProps {
  /** Whether the overlay is visible. */
  open: boolean;
  /** Called when the user dismisses the overlay (Escape, backdrop, close). */
  onClose: () => void;
  /** Platform info for rendering modifier hints; defaults to auto-detection. */
  platform?: PlatformInfo;
}

/**
 * The keyboard-shortcuts reference overlay. Lists every registered shortcut and
 * its action (Req 19.7). Returns `null` while closed so it adds nothing to the
 * DOM when not shown.
 */
export default function ShortcutHelp({
  open,
  onClose,
  platform = detectPlatform(),
}: ShortcutHelpProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // While open, move focus to the dialog's close control and dismiss on Escape.
  // The Escape handler is captured so it works regardless of focus within the
  // dialog (the overlay itself is the topmost interactive surface).
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-lg"
      data-shortcut-help="overlay"
    >
      {/* Backdrop: dismisses on click. */}
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        tabIndex={-1}
        class="absolute inset-0 cursor-default bg-ink/40"
        onClick={onClose}
      />

      {/* Dialog surface. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        class="relative z-10 w-full max-w-lg rounded-lg border border-hairline bg-canvas p-lg shadow-level-5"
      >
        <div class="mb-md flex items-center justify-between gap-md">
          <h2
            id="shortcut-help-title"
            class="text-display-sm text-ink"
          >
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-full text-body transition-colors hover:bg-canvas-soft-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
            aria-label="Close"
            onClick={onClose}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <line x1="5" y1="5" x2="15" y2="15" />
              <line x1="15" y1="5" x2="5" y2="15" />
            </svg>
          </button>
        </div>

        <ul role="list" class="flex flex-col divide-y divide-divider">
          {SHORTCUTS.map((shortcut) => (
            <li
              key={shortcut.id}
              data-shortcut-id={shortcut.id}
              class="flex items-center justify-between gap-md py-xs"
            >
              <div class="flex flex-col">
                <span class="text-body-sm-strong text-ink">{shortcut.label}</span>
                <span class="text-caption text-mute">{shortcut.description}</span>
              </div>
              <kbd class="shrink-0 rounded-xs border border-hairline bg-canvas-soft-2 px-xs py-xxs font-mono text-caption-mono text-body">
                {formatCombo(shortcut.combo, platform)}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
