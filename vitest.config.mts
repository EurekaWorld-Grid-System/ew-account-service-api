import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Keep test output readable: only errors from the code under test
    env: { LOG_LEVEL: 'error' },
  },
});
