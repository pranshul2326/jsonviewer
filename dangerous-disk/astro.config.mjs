// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Canonical production origin. Used to build absolute canonical/OG/Twitter
  // URLs and the sitemap. Change this in one place if the domain changes.
  site: 'https://jsonviewformat.com',

  // 100% client-side, statically exported app (Requirement 18: privacy).
  output: 'static',

  // Clean, canonical URLs with NO trailing slash (e.g. /about, /json-viewer).
  //
  // `build.format: 'file'` emits `about.html` instead of `about/index.html`.
  // Cloudflare's static-asset server maps that flat file to the extensionless
  // path `/about` and returns 200, while redirecting `/about/` -> `/about`.
  // `trailingSlash: 'never'` makes Astro build the <link rel="canonical"> and
  // Open Graph URLs without a trailing slash to match.
  //
  // The net effect: the served URL, the canonical tag, the sitemap and every
  // internal link all agree on ONE URL form, so Googlebot never hits a redirect
  // when it crawls a sitemap URL. This fixes the Search Console "Redirect error"
  // that occurred because the sitemap listed `/about` while the site served the
  // page at `/about/` (a 307 redirect).
  trailingSlash: 'never',
  build: {
    format: 'file',
  },

  // Interactive workbench is a set of Preact islands sharing nanostores state.
  integrations: [preact()],

  vite: {
    plugins: [tailwindcss()],

    // Monaco's language workers (json, editor) are emitted as separate,
    // same-origin ES worker chunks. The client island wires
    // `self.MonacoEnvironment.getWorker` to construct these workers from
    // same-origin URLs (e.g. `new Worker(new URL(
    //   'monaco-editor/esm/vs/language/json/json.worker?worker', import.meta.url))`),
    // so no Monaco worker is ever loaded cross-origin.
    worker: {
      format: 'es',
    },

    // Monaco ships its own ESM workers; let Vite handle them as worker chunks
    // rather than pre-bundling the whole editor.
    optimizeDeps: {
      exclude: ['monaco-editor'],
    },
  },
});
