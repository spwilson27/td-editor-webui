import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  plugins: [preact()],
  test: {
    coverage: { provider: 'v8', include: ['src/engine/**', 'src/bridge/**'] },
    projects: [
      { extends: true, test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.{ts,tsx}'],
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
});
