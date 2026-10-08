import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["adapter.test.ts", "test/**/*.test.ts"],
  },
});
