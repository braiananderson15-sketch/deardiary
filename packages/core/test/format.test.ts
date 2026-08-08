import { describe, expect, it } from "@effect/vitest";

import * as Entries from "../src/entries.ts";
import * as Format from "../src/format.ts";

const firstTimestamp = "2026-08-07T10:15:30.000Z";
const secondTimestamp = "2026-08-07T11:45:00.000Z";

const entry = (overrides: Partial<Entries.Entry> = {}): Entries.Entry =>
  new Entries.Entry({
    id: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000100",
    timestamp: firstTimestamp,
    model: "gpt-5",
    harness: "codex",
    mood: "win",
    tags: ["effect", "sqlite"],
    cwd: "/workspace/dear-diary",
    body: "The query layer is finally small and predictable.",
    updatedAt: firstTimestamp,
    deletedAt: null,
    ...overrides,
  });

describe("renderEntries", () => {
  it("renders a fully populated entry in a compact plain terminal format", () => {
    expect(Format.renderEntries([entry()])).toMatchInlineSnapshot(`
      "2026-08-07T10:15:30.000Z [WIN] gpt-5@codex
      project · /workspace/dear-diary
      tags: effect, sqlite

      The query layer is finally small and predictable."
    `);
  });

  it("handles nullable metadata, a global scope, and no tags", () => {
    expect(
      Format.renderEntries([
        entry({
          projectId: null,
          model: null,
          harness: null,
          tags: [],
          cwd: "/tmp/notes",
          mood: "note",
          body: "A global observation.",
        }),
      ]),
    ).toMatchInlineSnapshot(`
      "2026-08-07T10:15:30.000Z [NOTE] unknown model@unknown harness
      global · /tmp/notes

      A global observation."
    `);
  });

  it("presents every mood explicitly", () => {
    const moods: ReadonlyArray<Entries.Mood> = ["struggled", "win", "note", "idea", "rant"];
    const rendered = moods.map(
      (mood) => Format.renderEntries([entry({ mood, tags: [], body: mood })]).split("\n", 1)[0],
    );

    expect(rendered).toEqual([
      "2026-08-07T10:15:30.000Z [STRUGGLED] gpt-5@codex",
      "2026-08-07T10:15:30.000Z [WIN] gpt-5@codex",
      "2026-08-07T10:15:30.000Z [NOTE] gpt-5@codex",
      "2026-08-07T10:15:30.000Z [IDEA] gpt-5@codex",
      "2026-08-07T10:15:30.000Z [RANT] gpt-5@codex",
    ]);
  });

  it("preserves input order and multiline Unicode/Markdown bodies exactly", () => {
    const laterBody = "Later **Markdown** stays.\n\n- one\n- dois 😀";
    const earlierBody = "Earlier heading:\n# untouched";
    const output = Format.renderEntries([
      entry({ timestamp: secondTimestamp, updatedAt: secondTimestamp, body: laterBody }),
      entry({ body: earlierBody }),
    ]);

    expect(output.indexOf(laterBody)).toBeLessThan(output.indexOf(earlierBody));
    expect(output).toContain(laterBody);
    expect(output).toContain(earlierBody);
  });
});

describe("renderStats", () => {
  it("renders meaningful project/global and nullable buckets", () => {
    const stats: Entries.EntryStats = {
      total: 7,
      byMood: [
        { mood: "struggled", count: 2 },
        { mood: "win", count: 2 },
        { mood: "note", count: 1 },
        { mood: "idea", count: 1 },
        { mood: "rant", count: 1 },
      ],
      byProject: [
        { projectId: null, name: null, rootPath: null, count: 2 },
        {
          projectId: "00000000-0000-4000-8000-000000000100",
          name: "Dear Diary",
          rootPath: "/workspace/dear-diary",
          count: 4,
        },
        {
          projectId: "00000000-0000-4000-8000-000000000200",
          name: null,
          rootPath: "/workspace/unnamed",
          count: 1,
        },
      ],
      byModel: [
        { model: null, count: 2 },
        { model: "gpt-5", count: 3 },
        { model: "claude", count: 2 },
      ],
      byHarness: [
        { harness: "codex", count: 5 },
        { harness: null, count: 2 },
      ],
    };

    expect(Format.renderStats(stats)).toMatchInlineSnapshot(`
      "Dear Diary stats

      Total entries: 7

      Moods:
        STRUGGLED: 2
        WIN: 2
        NOTE: 1
        IDEA: 1
        RANT: 1

      Projects:
        Global: 2
        Dear Diary (/workspace/dear-diary): 4
        /workspace/unnamed: 1

      Models:
        Unknown model: 2
        gpt-5: 3
        claude: 2

      Harnesses:
        codex: 5
        Unknown harness: 2"
    `);
  });

  it("shows absent buckets instead of silently omitting them", () => {
    expect(
      Format.renderStats({ total: 1, byMood: [], byProject: [], byModel: [], byHarness: [] }),
    ).toContain("Moods:\n  (none)");
  });
});

describe("renderContext", () => {
  it("retains voice and distinguishes project entries from global observations", () => {
    expect(
      Format.renderContext([
        entry({ mood: "struggled", body: "The migration API still feels too magical." }),
        entry({
          projectId: null,
          timestamp: secondTimestamp,
          updatedAt: secondTimestamp,
          model: null,
          harness: null,
          tags: [],
          mood: "idea",
          cwd: "/workspace",
          body: "Maybe explain the storage boundary in one diagram.\nKeep it honest.",
        }),
      ]),
    ).toMatchInlineSnapshot(`
      "Dear Diary context:

      [2026-08-07T10:15:30.000Z | project | struggled | gpt-5@codex | /workspace/dear-diary | tags: effect, sqlite]
      The migration API still feels too magical.

      [2026-08-07T11:45:00.000Z | global | idea | unknown model@unknown harness | /workspace]
      Maybe explain the storage boundary in one diagram.
      Keep it honest."
    `);
  });
});

describe("renderMarkdown", () => {
  it("renders a complete light-header document in chronological input order", () => {
    const firstBody = "First paragraph.\n\n- kept as Markdown\n- with café ☕";
    const secondBody = "# A heading from the entry\n\n**Body markup is untouched.**";
    expect(
      Format.renderMarkdown([
        entry({ body: firstBody }),
        entry({
          projectId: null,
          timestamp: secondTimestamp,
          updatedAt: secondTimestamp,
          model: null,
          harness: null,
          tags: [],
          mood: "idea",
          cwd: "/workspace",
          body: secondBody,
        }),
      ]),
    ).toMatchInlineSnapshot(`
      "# Dear Diary

      ## 2026-08-07T10:15:30.000Z · gpt-5@codex · /workspace/dear-diary
      **Mood:** win
      **Tags:** effect, sqlite

      First paragraph.

      - kept as Markdown
      - with café ☕

      ---

      ## 2026-08-07T11:45:00.000Z · unknown model@unknown harness · /workspace
      **Mood:** idea

      # A heading from the entry

      **Body markup is untouched.**"
    `);
  });

  it("normalizes controls and escapes Markdown syntax in metadata without touching the body", () => {
    const body = "Body **stays bold**.\n\n# Body heading\n<script>alert('body')</script> 😀";
    const rendered = Format.renderMarkdown([
      entry({
        model: "gpt*[x]\n#next",
        harness: "co|dex\t<script>",
        tags: ["tag*one", "[two]"],
        cwd: "/work/# heading\n---",
        body,
      }),
    ]);

    expect(rendered).toMatchInlineSnapshot(`
      "# Dear Diary

      ## 2026-08-07T10:15:30.000Z · gpt\\*\\[x\\] \\#next@co\\|dex \\<script\\> · /work/\\# heading ---
      **Mood:** win
      **Tags:** tag\\*one, \\[two\\]

      Body **stays bold**.

      # Body heading
      <script>alert('body')</script> 😀"
    `);
    expect(rendered).toContain(body);
  });
});

describe("empty output", () => {
  it("is explicit for entries, stats, context, and Markdown exports", () => {
    expect(Format.renderEntries([])).toBe("No diary entries found.");
    expect(
      Format.renderStats({ total: 0, byMood: [], byProject: [], byModel: [], byHarness: [] }),
    ).toBe("Dear Diary stats\n\nNo diary entries found.");
    expect(Format.renderContext([])).toBe("Dear Diary context: no relevant entries found.");
    expect(Format.renderMarkdown([])).toBe("# Dear Diary\n\n_No diary entries found._");
  });
});
