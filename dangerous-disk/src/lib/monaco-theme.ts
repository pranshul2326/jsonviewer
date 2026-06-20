// Feature: json-viewer-free — Monaco dark-mode theming
//
// Monaco ships its own theming engine that is entirely independent of the
// Tailwind `--color-*` design tokens, so the editor surfaces keep painting
// their built-in light palette even when the rest of the app is in dark mode.
// This module bridges the gap: it defines token-aligned light/dark Monaco
// themes for both the plain editor (Viewer) and the diff editor (Diff Checker),
// reports which theme should be active from the `dark` class on <html>, and
// lets a panel react to live theme toggles.
//
// Monaco themes are a GLOBAL setting (there is no per-instance theme), but the
// app mounts only one Monaco-backed tool at a time (AppShell renders just the
// active panel), so switching the global theme per panel is safe.

import type * as Monaco from 'monaco-editor';

/** Monaco theme names registered by {@link defineMonacoThemes}. */
export const EDITOR_THEME_LIGHT = 'jvf-light';
export const EDITOR_THEME_DARK = 'jvf-dark';
export const DIFF_THEME_LIGHT = 'jvf-diff';
export const DIFF_THEME_DARK = 'jvf-diff-dark';

/** True when the app is currently in dark mode (the `dark` class is on <html>). */
export function isDarkTheme(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
  );
}

/** The plain-editor theme name matching the current app theme. */
export function editorThemeName(): string {
  return isDarkTheme() ? EDITOR_THEME_DARK : EDITOR_THEME_LIGHT;
}

/** The diff-editor theme name matching the current app theme. */
export function diffThemeName(): string {
  return isDarkTheme() ? DIFF_THEME_DARK : DIFF_THEME_LIGHT;
}

// Diff add/delete colors (Req 9.3/9.4) — green (cyan-deep) insertions, red
// (error) deletions — shared by the light and dark diff themes. Alpha suffixes
// give the translucent line/text fills.
const DIFF_COLORS = {
  'diffEditor.insertedTextBackground': '#29bc9b33',
  'diffEditor.insertedLineBackground': '#29bc9b1f',
  'diffEditor.removedTextBackground': '#ee000033',
  'diffEditor.removedLineBackground': '#ee00001f',
} as const;

// Dark surface colors aligned with the `html.dark` design tokens in theme.css
// (canvas #111111, ink #ededed, hairline #6e6e6e, inset surface #1c1c1c).
const DARK_EDITOR_COLORS = {
  'editor.background': '#111111',
  'editor.foreground': '#ededed',
  'editorGutter.background': '#111111',
  'editorLineNumber.foreground': '#6e6e6e',
  'editorLineNumber.activeForeground': '#ededed',
  'editor.lineHighlightBackground': '#1c1c1c',
  'editor.lineHighlightBorder': '#00000000',
  'editorIndentGuide.background': '#2a2a2a',
  'editorIndentGuide.activeBackground': '#3d3d3d',
  'editorWidget.background': '#1c1c1c',
  'editorWidget.border': '#2a2a2a',
  'editorCursor.foreground': '#ededed',
} as const;

let defined = false;

/**
 * Register the four app Monaco themes (idempotent). Must be called on a Monaco
 * module instance before creating an editor with one of the theme names or
 * calling {@link applyMonacoTheme}.
 */
export function defineMonacoThemes(monaco: typeof Monaco): void {
  if (defined) return;

  monaco.editor.defineTheme(EDITOR_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' },
  });

  monaco.editor.defineTheme(EDITOR_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { ...DARK_EDITOR_COLORS },
  });

  monaco.editor.defineTheme(DIFF_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { ...DIFF_COLORS },
  });

  monaco.editor.defineTheme(DIFF_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { ...DARK_EDITOR_COLORS, ...DIFF_COLORS },
  });

  defined = true;
}

/**
 * Set Monaco's global theme to the light/dark variant for `kind` based on the
 * current app theme.
 */
export function applyMonacoTheme(
  monaco: typeof Monaco,
  kind: 'editor' | 'diff',
): void {
  const name = kind === 'editor' ? editorThemeName() : diffThemeName();
  monaco.editor.setTheme(name);
}

/**
 * Observe app theme toggles (the `dark` class on <html>) and invoke `callback`
 * whenever it changes. Returns a disposer that stops observing. No-ops outside
 * the browser (SSR / test environments without a DOM).
 */
export function onAppThemeChange(callback: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let lastDark = isDarkTheme();
  const observer = new MutationObserver(() => {
    const nextDark = isDarkTheme();
    if (nextDark !== lastDark) {
      lastDark = nextDark;
      callback();
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}
