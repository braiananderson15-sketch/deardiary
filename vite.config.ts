import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    cache: {
      scripts: true,
    },
    tasks: {
      cli: {
        command: "node --experimental-strip-types apps/cli/src/cli.ts",
        cache: false,
      },
    },
  },
  staged: { "*": "vp fmt" },
  fmt: {
    ignorePatterns: [".repos/**", "**/.astro/**", "dist", "node_modules", "pnpm-lock.yaml"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [".repos/**", "**/.astro/**", "dist", "node_modules"],
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: { correctness: "warn", suspicious: "warn", perf: "warn" },
  },
});
