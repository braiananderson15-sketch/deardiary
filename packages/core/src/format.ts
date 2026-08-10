import type {
  Entry,
  EntryStats,
  HarnessCount,
  ModelCount,
  Mood,
  MoodCount,
  ProjectCount,
} from "./entries.ts";

const moodLabels: Readonly<Record<Mood, string>> = {
  struggled: "STRUGGLED",
  win: "WIN",
  note: "NOTE",
  idea: "IDEA",
  rant: "RANT",
};

const normalizeMetadata = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();

const metadataOr = (value: string | null, fallback: string): string => {
  if (value === null) return fallback;
  const normalized = normalizeMetadata(value);
  return normalized.length === 0 ? fallback : normalized;
};

const agentLabel = (entry: Entry): string =>
  `${metadataOr(entry.model, "unknown model")}@${metadataOr(entry.harness, "unknown harness")}`;

const scopeLabel = (entry: Entry): string => (entry.projectId === null ? "global" : "project");

const tagsLabel = (entry: Entry): string | null => {
  const tags = entry.tags.map((tag) => normalizeMetadata(tag)).filter((tag) => tag.length > 0);
  return tags.length === 0 ? null : tags.join(", ");
};

const projectRootLabel = (entry: Entry): string | null =>
  entry.projectRootPath === null || entry.projectRootPath === entry.cwd
    ? null
    : normalizeMetadata(entry.projectRootPath);

const renderTerminalEntry = (entry: Entry): string => {
  const tags = tagsLabel(entry);
  const projectRoot = projectRootLabel(entry);
  const header = [
    `${entry.timestamp} [${moodLabels[entry.mood]}] ${agentLabel(entry)}`,
    `${scopeLabel(entry)} · ${metadataOr(entry.cwd, "unknown cwd")}`,
    ...(projectRoot === null ? [] : [`repo: ${projectRoot}`]),
    ...(tags === null ? [] : [`tags: ${tags}`]),
  ].join("\n");
  return `${header}\n\n${entry.body}`;
};

/** Render entries for terminal output, preserving the caller-provided order. */
export const renderEntries = (entries: ReadonlyArray<Entry>): string =>
  entries.length === 0
    ? "No diary entries found."
    : entries.map(renderTerminalEntry).join("\n\n---\n\n");

const renderCountBucket = <A>(
  title: string,
  values: ReadonlyArray<A>,
  renderValue: (value: A) => string,
): string => `${title}:\n${values.length === 0 ? "  (none)" : values.map(renderValue).join("\n")}`;

const projectCountLabel = (value: ProjectCount): string => {
  if (value.projectId === null) return "Global";
  const name = metadataOr(value.name, "");
  const rootPath = metadataOr(value.rootPath, "");
  if (name.length > 0 && rootPath.length > 0) return `${name} (${rootPath})`;
  if (name.length > 0) return name;
  if (rootPath.length > 0) return rootPath;
  return "Unnamed project";
};

/** Render entry statistics for terminal output. */
export const renderStats = (stats: EntryStats): string => {
  if (stats.total === 0) return "Dear Diary stats\n\nNo diary entries found.";

  return [
    "Dear Diary stats",
    `Total entries: ${stats.total}`,
    renderCountBucket(
      "Moods",
      stats.byMood,
      (value: MoodCount) => `  ${moodLabels[value.mood]}: ${value.count}`,
    ),
    renderCountBucket(
      "Projects",
      stats.byProject,
      (value: ProjectCount) => `  ${projectCountLabel(value)}: ${value.count}`,
    ),
    renderCountBucket(
      "Models",
      stats.byModel,
      (value: ModelCount) => `  ${metadataOr(value.model, "Unknown model")}: ${value.count}`,
    ),
    renderCountBucket(
      "Harnesses",
      stats.byHarness,
      (value: HarnessCount) => `  ${metadataOr(value.harness, "Unknown harness")}: ${value.count}`,
    ),
  ].join("\n\n");
};

const escapeMarkdownMetadata = (value: string): string =>
  normalizeMetadata(value)
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]<>#|])/gu, "\\$1");

const markdownMetadataOr = (value: string | null, fallback: string): string => {
  const normalized = metadataOr(value, fallback);
  return escapeMarkdownMetadata(normalized);
};

const renderMarkdownEntry = (entry: Entry): string => {
  const model = markdownMetadataOr(entry.model, "unknown model");
  const harness = markdownMetadataOr(entry.harness, "unknown harness");
  const cwd = markdownMetadataOr(entry.cwd, "unknown cwd");
  const tags = entry.tags.map((tag) => escapeMarkdownMetadata(tag)).filter((tag) => tag.length > 0);
  const projectRoot = projectRootLabel(entry);
  const metadata = [
    `## ${entry.timestamp} · ${model}@${harness} · ${cwd}`,
    ...(projectRoot === null ? [] : [`**Project:** ${escapeMarkdownMetadata(projectRoot)}`]),
    `**Mood:** ${entry.mood}`,
    ...(tags.length === 0 ? [] : [`**Tags:** ${tags.join(", ")}`]),
  ].join("\n");
  return `${metadata}\n\n${entry.body}`;
};

/** Render a complete Markdown export, preserving chronological input order and entry prose. */
export const renderMarkdown = (entries: ReadonlyArray<Entry>): string =>
  entries.length === 0
    ? "# Dear Diary\n\n_No diary entries found._"
    : `# Dear Diary\n\n${entries.map(renderMarkdownEntry).join("\n\n---\n\n")}`;

const renderContextEntry = (entry: Entry): string => {
  const tags = tagsLabel(entry);
  const projectRoot = projectRootLabel(entry);
  const metadata = [
    entry.timestamp,
    scopeLabel(entry),
    entry.mood,
    agentLabel(entry),
    metadataOr(entry.cwd, "unknown cwd"),
    ...(tags === null ? [] : [`tags: ${tags}`]),
    ...(projectRoot === null ? [] : [`repo: ${projectRoot}`]),
  ].join(" | ");
  return `[${metadata}]\n${entry.body}`;
};

/** Render recent entries as concise context for an agent, preserving input order and voice. */
export const renderContext = (entries: ReadonlyArray<Entry>): string =>
  entries.length === 0
    ? "Dear Diary context: no relevant entries found."
    : `Dear Diary context:\n\n${entries.map(renderContextEntry).join("\n\n")}`;
