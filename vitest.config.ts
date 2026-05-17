import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/engine/**/__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
});