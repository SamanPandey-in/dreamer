import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    setupFiles: [path.resolve(__dirname, 'setup/vitest.setup.ts')],
    include: ['unit/**/*.test.ts', 'integration/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    isolate: true,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['../api-server/src/**/*.ts'],
      exclude: [
        '../api-server/src/generated/**',
        '../api-server/src/index.ts',
        '../api-server/src/workers/**',
        '**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@api': path.resolve(__dirname, '../api-server/src'),
      resend: path.resolve(__dirname, '../api-server/node_modules/resend'),
      bcryptjs: path.resolve(__dirname, '../api-server/node_modules/bcryptjs'),
    },
  },
});
