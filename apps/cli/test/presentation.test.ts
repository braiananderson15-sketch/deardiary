import { describe, expect, it } from "@effect/vitest";

import {
  renderLifecycleOutput,
  terminalColorEnabled,
  terminalPresentationEnabled,
} from "../src/presentation.ts";

describe("terminal presentation", () => {
  it("formats lifecycle checks as a compact, scannable report", () => {
    const output = renderLifecycleOutput({
      command: "doctor",
      exitCode: 0,
      color: false,
      output: [
        "OK CLI: Dear Diary 0.0.2, v24.19.0",
        "INFO Data: database not created yet (/tmp/deardiary.sqlite)",
        "WARN Codex skill: missing (/tmp/SKILL.md)",
        "OK MCP startup OK: 12 ms cold handshake, 3 tools, no daemon.",
        "FIX run 'npx -y @p4cs/deardiary@latest setup' to fix 1 warning automatically.",
      ].join("\n"),
    });

    expect(output).toContain("┌ Dear Diary · doctor");
    expect(output).toContain("✓ CLI  Dear Diary 0.0.2, v24.19.0");
    expect(output).toContain("• Data  database not created yet");
    expect(output).toContain("! Codex skill  missing");
    expect(output).not.toContain("FIX ");
    expect(output).toContain(
      "└ ! run 'npx -y @p4cs/deardiary@latest setup' to fix 1 warning automatically.",
    );
  });

  it("uses color only for capable terminals and keeps presentation independent from color", () => {
    expect(terminalPresentationEnabled(true)).toBe(true);
    expect(terminalPresentationEnabled(false)).toBe(false);
    expect(terminalColorEnabled({}, true)).toBe(true);
    expect(terminalColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(terminalColorEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(terminalColorEnabled({}, false)).toBe(false);

    const colored = renderLifecycleOutput({
      command: "setup",
      exitCode: 0,
      color: true,
      output: "Dear Diary setup is already current.",
    });
    expect(colored).toContain("\u001B[");
    expect(colored).toContain("Already beautifully current.");
  });

  it("continues an interactive setup flow and shortens home paths", () => {
    const home = process.env.HOME;
    const path = home === undefined ? "/tmp/SKILL.md" : `${home}/.agents/skills/deardiary/SKILL.md`;
    const output = renderLifecycleOutput({
      command: "setup",
      exitCode: 0,
      color: false,
      continuation: true,
      output: `Created ${path}\nSetup complete. Restart your agent sessions.`,
    });

    expect(output).not.toContain("┌ Dear Diary");
    expect(output).toMatch(/^│ ✓ Created /u);
    if (home !== undefined) expect(output).toContain("~/.agents/skills/deardiary/SKILL.md");
    expect(output).toContain("└ ✓ Restart your agent sessions.");
  });
});
