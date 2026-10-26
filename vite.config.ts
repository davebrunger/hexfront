import { minify } from 'html-minifier-terser';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** Minify the built HTML once the JS and CSS (already minified by Vite) have been inlined into it. */
function minifyHtml(): Plugin {
  return {
    name: 'minify-html',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue;
        file.source = await minify(String(file.source), {
          collapseWhitespace: true,
          removeComments: true,
          removeRedundantAttributes: true,
          useShortDoctype: true,
        });
      }
    },
  };
}

export default defineConfig({
  // Relative base so the built `dist/` folder works from any sub-path or file host.
  base: './',
  build: { target: 'es2022' },
  // Inline all JS and CSS so the build is a single self-contained, minified `dist/index.html`.
  plugins: [viteSingleFile(), minifyHtml()],
});
