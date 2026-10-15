import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      "@workbench/sync-contracts": "/Users/nicholas/Documents/Workbench Web/packages/sync-contracts/src/index.ts",
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
