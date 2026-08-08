import { defineConfig } from "vite-plus";

export const shouldBundleCliDependency = (id: string): boolean => id.startsWith("@deardiary/");

export default defineConfig({
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
