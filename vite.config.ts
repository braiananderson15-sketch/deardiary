import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: { "*": "vp fmt" },
  fmt: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml"],
    sortPackageJson: {},
  },
  lint: {
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: { correctness: "warn", suspicious: "warn", perf: "warn" },
  },
});
