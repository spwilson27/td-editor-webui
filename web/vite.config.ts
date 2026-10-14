import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Production build is one self-contained html file that TouchDesigner embeds in a Text DAT.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    target: 'es2020',
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
});
