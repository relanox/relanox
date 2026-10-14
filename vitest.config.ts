import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Keep the actual QQ SDK while routing its WebSocket transport to protocol peers.
    server: { deps: { inline: ['@tencent-connect/qqbot-nodejs'] } },
    include: [
      'tests/**/*.test.ts',
      'packages/**/*.test.ts',
      'plugins/**/*.test.ts',
      'apps/**/*.test.ts'
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '.worktree/**', '**/.ref/**'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true
  }
})
