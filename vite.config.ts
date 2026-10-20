import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built `dist/` folder works from any sub-path or file host.
  base: './',
  build: { target: 'es2022' },
});
