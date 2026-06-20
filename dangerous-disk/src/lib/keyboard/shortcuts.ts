// Feature: json-viewer-free — Task 18.1
//
// The keyboard-shortcut registry: the single, data-driven source of truth for
// every keyboard shortcut the application responds to (Req 19). It is kept free
// of any UI framework so it can be:
//   • consumed by the global key manager wired into AppShell (Req 19.6),
//   • rendered by the ShortcutHelp reference overlay (Req 19.7), and
//   • targeted directly by the Task 18.2 property tests (clear empties the
//     editor — Req 19.2; the reference lists every shortcut — Req 19.7).
//
// Each entry pairs a key combo with an action id and the human-readable label
// used by the reference. Document-level actions (format, clear) act on the
// shared `$document` store directly so they are testable without a DOM; the
// UI-coupled actions (collapse-all, tool switching with visible focus, opening
// the reference) are supplied by the host via a {@link ShortcutContext}.
//
// Matching is platform-aware: the "Mod" modifier is Ctrl on Windows/Linux and
// Cmd (meta) on macOS, so a single registry entry serves both platforms.

import { format } from '../json-core/serialize';
import {
  $document,
  $settings,
  setDocumentText,
  type Tool,
} from '../stores/document';

// ---------------------------------------------------------------------------
// Key combos
// ---------------------------------------------------------------------------

/**
 * A normalized key combination.
 *
 *   - `key`      — the target key. Single characters are matched
 *                  case-insensitively (so `f` matches a Shift+F `KeyboardEvent`
 *                  whose `key` is `"F"`); multi-character names such as
 *                  `"Enter"` are matched verbatim.
 *   - `mod`      — requires the platform "command" modifier (Ctrl on
 *                  Windows/Linux, Cmd/meta on macOS). Defaults to not-required.
 *   - `shift`    — when defined, the Shift state must match exactly; when
 *                  omitted the Shift state is not constrained (used for keys
 *                  like `?` that already imply Shift on most layouts).
 *   - `alt`      — requires the Alt/Option modifier. Defaults to not-required.
 */
export interface KeyCombo {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

// ---------------------------------------------------------------------------
// Shortcut actions
// ---------------------------------------------------------------------------

/** The action a shortcut performs when invoked. */
export type ShortcutAction =
  | 'format'
  | 'clear'
  | 'collapse-all'
  | 'switch-tool'
  | 'shortcuts-help';

/** A stable identifier for each registered shortcut. */
export type ShortcutId =
  | 'format'
  | 'clear'
  | 'collapse-all'
  | 'shortcuts-help'
  | 'tab-viewer'
  | 'tab-diff'
  | 'tab-grid'
  | 'tab-converter';

/** A single registry entry. */
export interface Shortcut {
  /** Stable id, unique within the registry. */
  id: ShortcutId;
  /** The key combination that triggers this shortcut. */
  combo: KeyCombo;
  /** The action performed when invoked. */
  action: ShortcutAction;
  /** For `switch-tool` actions, the tool to focus/activate (Req 19.5). */
  tool?: Tool;
  /** Short action label shown in the reference overlay (Req 19.7). */
  label: string;
  /** Longer description of the action shown in the reference overlay. */
  description: string;
}

/**
 * The host-supplied capabilities for UI-coupled actions. Document-level actions
 * (format, clear) act on the shared store directly and do not need the context.
 */
export interface ShortcutContext {
  /** Collapse every expandable node in the active viewer tree (Req 19.4). */
  collapseAll: () => void;
  /** Activate the given tool and move a visible keyboard focus to it (Req 19.5). */
  switchTool: (tool: Tool) => void;
  /** Open the keyboard-shortcuts reference overlay (Req 19.7). */
  openShortcutsHelp: () => void;
}

// ---------------------------------------------------------------------------
// Document-level actions (store-backed, DOM-free, directly testable)
// ---------------------------------------------------------------------------

/**
 * Format the shared document using the currently selected indentation style
 * (Req 19.1 → Req 5). When the document is empty or invalid JSON the action is
 * a no-op, leaving the editor content byte-for-byte unchanged (Req 5.7/5.8).
 */
export function formatDocument(): void {
  const { parsed } = $document.get();
  if (parsed.ok && !parsed.empty) {
    const { indentStyle } = $settings.get();
    setDocumentText(format(parsed.model, indentStyle));
  }
}

/**
 * Clear the editor (Req 19.2). When the editor already holds zero characters
 * this is a no-op and the editor is left unchanged (Req 19.3).
 */
export function clearEditor(): void {
  if ($document.get().text.length > 0) {
    setDocumentText('');
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every keyboard shortcut the application responds to, in reference-display
 * order. This array is the single source of truth: the key manager matches
 * against it, and the reference overlay renders it in full (Req 19.7).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'format',
    combo: { key: 'f', mod: true, shift: true },
    action: 'format',
    label: 'Format document',
    description: 'Beautify the editor JSON using the selected indentation.',
  },
  {
    id: 'clear',
    combo: { key: 'k', mod: true, shift: true },
    action: 'clear',
    label: 'Clear editor',
    description: 'Remove all content from the editor.',
  },
  {
    id: 'collapse-all',
    combo: { key: 'e', mod: true, shift: true },
    action: 'collapse-all',
    label: 'Collapse all',
    description: 'Collapse every node in the tree so only the root remains.',
  },
  {
    id: 'tab-viewer',
    combo: { key: '1', mod: true, shift: false },
    action: 'switch-tool',
    tool: 'viewer',
    label: 'Go to Viewer',
    description: 'Switch focus to the Viewer tool.',
  },
  {
    id: 'tab-diff',
    combo: { key: '2', mod: true, shift: false },
    action: 'switch-tool',
    tool: 'diff',
    label: 'Go to Diff Checker',
    description: 'Switch focus to the Diff Checker tool.',
  },
  {
    id: 'tab-grid',
    combo: { key: '3', mod: true, shift: false },
    action: 'switch-tool',
    tool: 'grid',
    label: 'Go to Table Grid',
    description: 'Switch focus to the Table Grid tool.',
  },
  {
    id: 'tab-converter',
    combo: { key: '4', mod: true, shift: false },
    action: 'switch-tool',
    tool: 'converter',
    label: 'Go to Converter',
    description: 'Switch focus to the Converter tool.',
  },
  {
    id: 'shortcuts-help',
    combo: { key: '?' },
    action: 'shortcuts-help',
    label: 'Keyboard shortcuts',
    description: 'Show this list of keyboard shortcuts.',
  },
] as const;

// ---------------------------------------------------------------------------
// Combo formatting (human-readable hints for the reference overlay)
// ---------------------------------------------------------------------------

/** A subset of the platform info needed to render combo hints. */
export interface PlatformInfo {
  /** Whether the current platform uses Cmd (⌘) for the "Mod" modifier. */
  isMac: boolean;
}

/** Best-effort detection of a macOS platform for modifier labeling. */
export function detectPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') return { isMac: false };
  const platform =
    // `userAgentData` is not in every lib.dom; fall back to the UA string.
    (navigator as unknown as { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    '';
  return { isMac: /mac|iphone|ipad|ipod/i.test(platform) };
}

/** Render a single key for display (e.g. `f` → `F`, `ArrowUp` → `↑`). */
function displayKey(key: string): string {
  switch (key) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case ' ':
      return 'Space';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Render a {@link KeyCombo} as a human-readable hint string, e.g.
 * `"⌘ + Shift + F"` on macOS or `"Ctrl + Shift + F"` elsewhere. Used by the
 * reference overlay so every shortcut shows its keys alongside its action.
 */
export function formatCombo(
  combo: KeyCombo,
  platform: PlatformInfo = detectPlatform(),
): string {
  const parts: string[] = [];
  if (combo.mod) parts.push(platform.isMac ? '⌘' : 'Ctrl');
  if (combo.shift) parts.push('Shift');
  if (combo.alt) parts.push(platform.isMac ? '⌥' : 'Alt');
  parts.push(displayKey(combo.key));
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Matching and dispatch
// ---------------------------------------------------------------------------

/** Normalize a key for comparison: single chars are lowercased. */
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** The subset of a `KeyboardEvent` that matching depends on. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Does `event` satisfy `combo`? The "Mod" modifier matches either Ctrl or Meta
 * so one entry works on every platform. Shift is only enforced when the combo
 * defines it; Alt and Mod default to "must not be pressed" when omitted.
 */
export function matchesCombo(event: KeyEventLike, combo: KeyCombo): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (Boolean(combo.mod) !== mod) return false;
  if (Boolean(combo.alt) !== event.altKey) return false;
  if (combo.shift !== undefined && combo.shift !== event.shiftKey) return false;
  return normalizeKey(event.key) === normalizeKey(combo.key);
}

/** Find the first registered shortcut whose combo matches `event`, if any. */
export function findShortcut(event: KeyEventLike): Shortcut | undefined {
  return SHORTCUTS.find((shortcut) => matchesCombo(event, shortcut.combo));
}

/** Run a shortcut's action, using `ctx` for the UI-coupled actions. */
export function runShortcut(shortcut: Shortcut, ctx: ShortcutContext): void {
  switch (shortcut.action) {
    case 'format':
      formatDocument();
      return;
    case 'clear':
      clearEditor();
      return;
    case 'collapse-all':
      ctx.collapseAll();
      return;
    case 'switch-tool':
      if (shortcut.tool) ctx.switchTool(shortcut.tool);
      return;
    case 'shortcuts-help':
      ctx.openShortcutsHelp();
      return;
  }
}

/**
 * Match `event` against the registry and, if a shortcut applies, run it.
 * Returns the shortcut that was invoked (so the caller can `preventDefault`),
 * or `undefined` when no shortcut matched.
 */
export function dispatchShortcut(
  event: KeyEventLike,
  ctx: ShortcutContext,
): Shortcut | undefined {
  const shortcut = findShortcut(event);
  if (shortcut) runShortcut(shortcut, ctx);
  return shortcut;
}

// ---------------------------------------------------------------------------
// Collapse-all command bus
// ---------------------------------------------------------------------------
//
// The collapse-all action must reach whichever viewer tree is mounted, without
// the key manager holding a reference to it. A lightweight window CustomEvent
// decouples the two: the key manager requests a collapse, and the active
// viewer (wired in a later task) listens for it. This keeps the registry and
// AppShell free of any direct viewer dependency.

/** The window event name used to broadcast a collapse-all request (Req 19.4). */
export const COLLAPSE_ALL_EVENT = 'jvf:collapse-all';

/** Broadcast a collapse-all request to any listening viewer tree (Req 19.4). */
export function requestCollapseAll(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(COLLAPSE_ALL_EVENT));
}
