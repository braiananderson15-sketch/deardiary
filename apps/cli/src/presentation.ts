import * as Prompts from "@clack/prompts";

export type LifecycleCommand = "setup" | "doctor" | "bench-startup" | "uninstall";

interface RenderLifecycleOptions {
  readonly command: LifecycleCommand;
  readonly output: string;
  readonly exitCode: number;
  readonly color: boolean;
  readonly continuation?: boolean;
}

const ansi = (open: number, close: number, enabled: boolean, text: string): string =>
  enabled ? `\u001B[${String(open)}m${text}\u001B[${String(close)}m` : text;

const paint = (enabled: boolean) => ({
  accent: (text: string) => ansi(35, 39, enabled, text),
  bold: (text: string) => ansi(1, 22, enabled, text),
  dim: (text: string) => ansi(2, 22, enabled, text),
  error: (text: string) => ansi(31, 39, enabled, text),
  info: (text: string) => ansi(36, 39, enabled, text),
  success: (text: string) => ansi(32, 39, enabled, text),
  warning: (text: string) => ansi(33, 39, enabled, text),
});

export const terminalPresentationEnabled = (
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean => isTTY === true;

export const terminalColorEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean =>
  terminalPresentationEnabled(isTTY) &&
  !("NO_COLOR" in env) &&
  env.TERM !== "dumb" &&
  env.FORCE_COLOR !== "0";

const commandLabel: Readonly<Record<LifecycleCommand, string>> = {
  setup: "setup",
  doctor: "doctor",
  "bench-startup": "startup benchmark",
  uninstall: "uninstall",
};

const compactTerminalPaths = (text: string): string => {
  const home = process.env.HOME;
  return home === undefined || home.length <= 1 ? text : text.replaceAll(`${home}/`, "~/");
};

const splitDetail = (text: string): readonly [string, string | null] => {
  const separator = text.indexOf(": ");
  return separator === -1
    ? [text.replace(/:$/u, ""), null]
    : [text.slice(0, separator), text.slice(separator + 2)];
};

const formatStatusLine = (
  line: string,
  color: boolean,
): { readonly symbol: string; readonly text: string } => {
  const style = paint(color);
  const trimmed = line.trimStart();
  const match =
    /^(OK|CURRENT|UNCHANGED|WARN|MISSING|DRIFTED|FAIL|ERROR|INFO|SKIPPED)\s+(.+)$/u.exec(trimmed);
  if (match !== null) {
    const [, status = "", remainder = ""] = match;
    const [rawLabel, detail] = splitDetail(remainder);
    const label = status === "OK" ? rawLabel.replace(/ OK$/u, "") : rawLabel;
    const rendered =
      detail === null ? style.bold(label) : `${style.bold(label)}  ${style.dim(detail)}`;
    if (["OK", "CURRENT", "UNCHANGED"].includes(status)) {
      return { symbol: style.success("✓"), text: rendered };
    }
    if (["WARN", "MISSING", "DRIFTED"].includes(status)) {
      return { symbol: style.warning("!"), text: rendered };
    }
    if (["FAIL", "ERROR"].includes(status)) {
      return { symbol: style.error("×"), text: rendered };
    }
    return { symbol: style.info("•"), text: rendered };
  }

  const action = /^(CREATE|UPDATE|REMOVE|DELETE)\s+(.+)$/u.exec(trimmed);
  if (action !== null) {
    const [, verb = "", target = ""] = action;
    return {
      symbol: style.accent("+"),
      text: `${style.bold(`${verb[0]}${verb.slice(1).toLowerCase()}`)} ${style.dim(target)}`,
    };
  }

  if (/^(Created|Updated|Backed up|Removed|Deleted)\b/u.test(trimmed)) {
    return { symbol: style.success("✓"), text: line };
  }
  if (/^(Setup|Uninstall|MCP startup) (failed|aborted)/u.test(trimmed)) {
    return { symbol: style.error("×"), text: line };
  }
  if (/^(Setup|Uninstall) cancelled/u.test(trimmed)) {
    return { symbol: style.info("•"), text: line };
  }
  if (/^(Setup|Uninstall) preview/u.test(trimmed)) {
    return { symbol: style.accent("◇"), text: style.bold(line.replace(/:$/u, "")) };
  }
  if (trimmed.startsWith("FIX ")) {
    return { symbol: style.warning("!"), text: trimmed.slice(4) };
  }
  if (/^[+-]\s/u.test(trimmed) || trimmed.startsWith("backup:")) {
    return { symbol: " ", text: style.dim(trimmed) };
  }
  if (trimmed.startsWith("MCP command:")) {
    return { symbol: style.info("•"), text: style.dim(trimmed) };
  }
  return { symbol: style.dim("│"), text: line };
};
const successFooter = (command: LifecycleCommand, output: string): string => {
  if (command === "doctor") return "Everything looks good.";
  if (command === "bench-startup") return "Ready when you are.";
  if (command === "setup" && output.startsWith("Setup cancelled")) return "Nothing changed.";
  if (command === "setup" && output.includes("already current"))
    return "Already beautifully current.";
  if (command === "setup") return "You're all set.";
  return "Done.";
};

/** Dress human-facing lifecycle output without changing its redirected, script-friendly form. */
export const renderLifecycleOutput = ({
  command,
  output,
  exitCode,
  color,
  continuation = false,
}: RenderLifecycleOptions): string => {
  const style = paint(color);
  const displayOutput = compactTerminalPaths(output);
  const lines = displayOutput.split("\n");
  const completion = lines.find((line) =>
    /^(Setup complete\.|Dear Diary setup is already current\.)/u.test(line),
  );
  const fix = lines.find((line) => line.startsWith("FIX "));
  const footerFix = exitCode === 0 ? fix : undefined;
  const body = lines.filter((line) => line !== completion && line !== footerFix);
  const rendered = body.map((line) => {
    if (line.length === 0) return style.accent("│");
    const formatted = formatStatusLine(line, color);
    return `${style.accent("│")} ${formatted.symbol} ${formatted.text}`.trimEnd();
  });
  const footer =
    exitCode === 0
      ? footerFix !== undefined
        ? footerFix.slice(4)
        : completion === undefined
          ? successFooter(command, displayOutput)
          : completion.startsWith("Setup complete.")
            ? completion.replace(/^Setup complete\.\s*/u, "")
            : "Already beautifully current."
      : "Some checks need your attention.";
  const footerSymbol =
    exitCode !== 0
      ? style.error("×")
      : footerFix === undefined
        ? style.success("✓")
        : style.warning("!");
  const styledFooter =
    exitCode !== 0
      ? style.error(footer)
      : footerFix === undefined
        ? style.success(footer)
        : style.warning(footer);

  return [
    ...(continuation
      ? []
      : [
          `${style.accent("┌")} ${style.bold("Dear Diary")} ${style.dim(`· ${commandLabel[command]}`)}`,
          style.accent("│"),
        ]),
    ...rendered,
    style.accent("│"),
    `${style.accent("└")} ${footerSymbol} ${styledFooter}`,
  ].join("\n");
};

const setupConfirmationSuffix = "\nApply these changes? Type 'yes': ";

/** Show the setup plan once, then ask a concise native terminal question. */
export const confirmSetupChanges = async (question: string): Promise<string> => {
  const preview = question.endsWith(setupConfirmationSuffix)
    ? question.slice(0, -setupConfirmationSuffix.length)
    : question;
  const [title = "Setup preview", ...details] = preview.split("\n");
  Prompts.note(
    compactTerminalPaths(details.join("\n").replace(/^ {2}/gmu, "")),
    title.replace(/:$/u, ""),
  );
  const confirmed = await Prompts.confirm({ message: "Apply these changes?" });
  if (Prompts.isCancel(confirmed)) {
    Prompts.cancel("Setup cancelled.");
    return "no";
  }
  return confirmed ? "yes" : "no";
};

export interface Activity {
  readonly finish: (ok: boolean) => void;
}

export const startDoctorActivity = (): Activity => {
  const activity = Prompts.spinner();
  activity.start("Checking your Dear Diary installation");
  return {
    finish: (ok) => {
      if (ok) activity.stop("Checkup complete");
      else activity.error("Checkup found a few things");
    },
  };
};
