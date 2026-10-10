import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "plugins/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", ".worktree/**", "**/.ref/**"],
    testTimeout: 15000,
    hookTimeout: 30000,
    restoreMocks: true,
  },
});
