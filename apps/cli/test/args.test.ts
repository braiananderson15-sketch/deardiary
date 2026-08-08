import { describe, expect, it } from "@effect/vitest";

import { CliUsageError, parseArgs } from "../src/args.ts";

describe("setup arguments", () => {
  it("defaults to global guidance", () => {
    expect(parseArgs(["setup"])).toEqual({
      kind: "setup",
      check: false,
      yes: false,
      guidance: "global",
    });
  });

  it.each(["global", "project", "none"] as const)("accepts the %s guidance scope", (guidance) => {
    expect(parseArgs(["setup", "--guidance", guidance])).toMatchObject({
      kind: "setup",
      guidance,
    });
  });

  it("keeps check and yes mutually exclusive", () => {
    expect(() => parseArgs(["setup", "--check", "--yes"])).toThrowError(
      new CliUsageError("Options '--check' and '--yes' are mutually exclusive.", "setup"),
    );
  });

  it("rejects an invalid guidance scope", () => {
    expect(() => parseArgs(["setup", "--guidance", "local"])).toThrowError(
      "Invalid guidance scope 'local'. Expected one of: global, project, none.",
    );
  });

  it("returns setup help without requiring other options", () => {
    expect(parseArgs(["setup", "--help", "--guidance", "local"])).toEqual({
      kind: "help",
      command: "setup",
    });
  });
});

describe("uninstall arguments", () => {
  it("defaults to integrations and global guidance", () => {
    expect(parseArgs(["uninstall"])).toEqual({
      kind: "uninstall",
      level: "integrations",
      explicitLevel: false,
      yes: false,
      guidance: "global",
    });
  });

  it.each(["global", "project"] as const)("accepts the %s guidance scope", (guidance) => {
    expect(parseArgs(["uninstall", "--guidance", guidance])).toMatchObject({
      kind: "uninstall",
      guidance,
    });
  });

  it("rejects none and unknown guidance scopes", () => {
    for (const guidance of ["none", "local"]) {
      expect(() => parseArgs(["uninstall", "--guidance", guidance])).toThrowError(
        `Invalid guidance scope '${guidance}'. Expected one of: global, project.`,
      );
    }
  });

  it("still requires an explicit level with yes", () => {
    expect(() => parseArgs(["uninstall", "--yes", "--guidance", "project"])).toThrowError(
      "Option '--yes' requires an explicit '--level'.",
    );
  });

  it("accepts yes with an explicit level and project guidance", () => {
    expect(
      parseArgs(["uninstall", "--level", "integrations", "--yes", "--guidance", "project"]),
    ).toEqual({
      kind: "uninstall",
      level: "integrations",
      explicitLevel: true,
      yes: true,
      guidance: "project",
    });
  });

  it("returns uninstall help without requiring other options", () => {
    expect(parseArgs(["uninstall", "--help", "--guidance", "none"])).toEqual({
      kind: "help",
      command: "uninstall",
    });
  });
});
