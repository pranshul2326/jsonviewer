/** @jsxImportSource preact */
// Feature: json-viewer-free — dark-mode toggle
//
// ThemeToggle: a small island that flips the app between the light and dark
// palettes. The actual palettes live entirely in `theme.css` as `--color-*`
// token overrides under `html.dark`; this control only adds/removes that class
// (plus the native `color-scheme`) and persists the choice to localStorage so
// it survives reloads. The no-FOUC bootstrap in Layout.astro applies the saved
// value before first paint, so this component simply mirrors and toggles it.
//
// Everything stays on-device (localStorage only) — no network, consistent with
// the privacy-first design. Styling derives from the same design tokens as the
// rest of the nav chrome (Req 22.1).

import { useEffect, useState } from 'preact/hooks';

/** The two supported themes. */
type Theme = 'light' | 'dark';

/** localStorage key shared with the Layout bootstrap script. */
const STORAGE_KEY = 'theme';

/**
 * Read the theme that is currently applied to the document. The Layout
 * bootstrap has already resolved localStorage / OS preference and set the
 * `dark` class before hydration, so the live DOM is the source of truth.
 */
function readAppliedTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Apply a theme to <html> and persist it for subsequent loads. */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* persistence unavailable (e.g. private mode) — the in-session toggle still works. */
  }
}

/**
 * The light/dark toggle button. Shows a moon while in light mode (click to go
 * dark) and a sun while in dark mode (click to go light), with an accessible
 * label that always describes the action it performs.
 */
export default function ThemeToggle() {
  // Default to 'light' for SSR; the real applied value is read after mount so
  // the icon/label match what the bootstrap script already painted.
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readAppliedTheme());

    // Keep in sync with the OS preference while the user has not made an
    // explicit choice (no stored value). `matchMedia` is absent in some
    // environments (e.g. jsdom under test), so guard before subscribing.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (stored !== 'light' && stored !== 'dark') {
        const next: Theme = event.matches ? 'dark' : 'light';
        document.documentElement.classList.toggle('dark', next === 'dark');
        document.documentElement.style.colorScheme = next;
        setTheme(next);
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      data-theme-toggle
      data-theme={theme}
      class="inline-flex items-center justify-center rounded-full p-2 text-body transition-colors hover:bg-canvas-soft-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
      aria-label={label}
      title={label}
      aria-pressed={isDark}
      onClick={toggle}
    >
      {isDark ? (
        // Sun glyph — shown in dark mode (click returns to light).
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="3.5" />
          <line x1="10" y1="1.5" x2="10" y2="3.5" />
          <line x1="10" y1="16.5" x2="10" y2="18.5" />
          <line x1="1.5" y1="10" x2="3.5" y2="10" />
          <line x1="16.5" y1="10" x2="18.5" y2="10" />
          <line x1="3.9" y1="3.9" x2="5.3" y2="5.3" />
          <line x1="14.7" y1="14.7" x2="16.1" y2="16.1" />
          <line x1="3.9" y1="16.1" x2="5.3" y2="14.7" />
          <line x1="14.7" y1="5.3" x2="16.1" y2="3.9" />
        </svg>
      ) : (
        // Moon glyph — shown in light mode (click switches to dark).
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M16.5 11.2A6.5 6.5 0 0 1 8.8 3.5a6.5 6.5 0 1 0 7.7 7.7Z" />
        </svg>
      )}
    </button>
  );
}
