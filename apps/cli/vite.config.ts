import { defineConfig } from "vite-plus";

export const shouldBundleCliDependency = (id: string): boolean => id.startsWith("@deardiary/");

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  pack: {
    entry: ["src/cli.ts"],
    deps: {
      alwaysBundle: shouldBundleCliDependency,
      onlyBundle: false,
    },
    dts: false,
    format: ["esm"],
    minify: false,
  },
});
