import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // Relative base so the built `dist/` folder works from any sub-path or file host.
  base: './',
  build: { target: 'es2022' },
  // Inline all JS and CSS so the build is a single self-contained `dist/index.html`.
  plugins: [viteSingleFile()],
});
