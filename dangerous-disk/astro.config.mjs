// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // 100% client-side, statically exported app (Requirement 18: privacy).
  output: 'static',

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
