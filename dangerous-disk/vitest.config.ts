/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// Vitest configuration for Json Viewer Free.
//
// - `jsdom` environment so DOM-dependent islands (Monaco wrapper, Preact
//   components, clipboard) and the pure json-core can be tested together.
// - `@fast-check/vitest` is consumed directly inside test files via
//   `import { test, fc } from '@fast-check/vitest'`; no global registration is
//   required, it layers on top of Vitest's runner. Property tests run at
//   >=100 iterations as configured per-property.
// - We reuse Astro's Vite pipeline via `getViteConfig` so tests resolve the
//   same aliases, plugins, and module graph as the app build.
export default getViteConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
