import { describe, expect, it } from "@effect/vitest";

import { shouldBundleCliDependency } from "../vite.config.ts";

describe("CLI packaging configuration", () => {
  it("bundles every internal package while leaving published runtime packages external", () => {
    expect(shouldBundleCliDependency("@deardiary/core/db")).toBe(true);
    expect(shouldBundleCliDependency("@deardiary/mcp")).toBe(true);
    expect(shouldBundleCliDependency("@effect/platform-node/NodeServices")).toBe(false);
    expect(shouldBundleCliDependency("effect/Effect")).toBe(false);
  });
});
