import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { resolveWizardPath } from "../src/setup-wizard.ts";

describe("setup wizard paths", () => {
  it("expands home paths and resolves relative custom paths from the working directory", () => {
    const home = NodePath.resolve("/users/example");
    const cwd = NodePath.resolve("/work/project");

    expect(resolveWizardPath("~/.custom/skills", home, cwd)).toBe(
      NodePath.join(home, ".custom", "skills"),
    );
    expect(resolveWizardPath("./AGENTS.md", home, cwd)).toBe(NodePath.join(cwd, "AGENTS.md"));
    expect(resolveWizardPath(" /absolute/AGENTS.md ", home, cwd)).toBe(
      NodePath.resolve("/absolute/AGENTS.md"),
    );
  });
});
