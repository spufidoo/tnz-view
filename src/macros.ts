import * as vscode from "vscode";
import { AID_NAMES, NAV_NAMES } from "./keymap";

/**
 * A macro is text with `[action]` markers in it, in the style emulators have
 * used for decades:
 *
 *     LOGON APPLID(TSO)[enter][wait]USERID[tab]PASSWORD[enter]
 *
 * `[[` is a literal `[`. Long macros can be written as an array of strings,
 * which are joined without a separator.
 */
export type MacroSource = string | string[];

export type MacroStep =
  | { kind: "text"; value: string }
  | { kind: "aid"; value: string }
  | { kind: "nav"; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "pause"; ms: number }
  | { kind: "prompt"; label: string; secret: boolean };

export class MacroError extends Error {}

const DEFAULT_WAIT_MS = 10000;

export function getMacros(): Record<string, MacroSource> {
  return (
    vscode.workspace
      .getConfiguration("tnzView")
      .get<Record<string, MacroSource>>("macros", {}) || {}
  );
}

/** Parse a macro, throwing MacroError with the offending marker named. */
export function parseMacro(source: MacroSource): MacroStep[] {
  const text = Array.isArray(source) ? source.join("") : String(source ?? "");
  const steps: MacroStep[] = [];
  let literal = "";

  const flush = () => {
    if (literal) {
      steps.push({ kind: "text", value: literal });
      literal = "";
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "[") {
      literal += ch;
      continue;
    }
    if (text[i + 1] === "[") {
      literal += "[";
      i++;
      continue;
    }
    const close = text.indexOf("]", i + 1);
    if (close === -1) {
      throw new MacroError(`unclosed "[" at position ${i + 1}`);
    }
    flush();
    steps.push(parseMarker(text.slice(i + 1, close)));
    i = close;
  }
  flush();
  return steps;
}

function parseMarker(body: string): MacroStep {
  // Split on the first colon only: a prompt label may contain colons.
  const colon = body.indexOf(":");
  const rawName = colon === -1 ? body : body.slice(0, colon);
  const rawArg = colon === -1 ? undefined : body.slice(colon + 1);
  const name = rawName.trim().toLowerCase();

  if (name === "prompt" || name === "password") {
    const label = (rawArg ?? "").trim();
    return {
      kind: "prompt",
      label: label || (name === "password" ? "Password" : "Value"),
      secret: name === "password",
    };
  }

  if (name === "wait" || name === "pause") {
    const ms = rawArg === undefined ? undefined : Number(rawArg.trim());
    if (rawArg !== undefined && (!Number.isFinite(ms) || ms! < 0)) {
      throw new MacroError(`[${body}] needs a time in milliseconds`);
    }
    if (name === "pause" && ms === undefined) {
      throw new MacroError("[pause] needs a time, e.g. [pause:500]");
    }
    return { kind: name, ms: ms ?? DEFAULT_WAIT_MS } as MacroStep;
  }

  const known = AID_NAMES.includes(name) || NAV_NAMES.includes(name);
  if (known && rawArg !== undefined) {
    throw new MacroError(`[${body}] does not take a value`);
  }
  if (AID_NAMES.includes(name)) {
    return { kind: "aid", value: name };
  }
  if (NAV_NAMES.includes(name)) {
    return { kind: "nav", value: name };
  }
  throw new MacroError(
    `[${body}] is not a known action. Use an AID (${AID_NAMES.slice(0, 6).join(
      ", "
    )}, pf1-24), a cursor key (${NAV_NAMES.slice(0, 4).join(
      ", "
    )}, …), [prompt:label], [password:label], [wait] or [pause:ms].`
  );
}

export function hasPrompt(steps: MacroStep[]): boolean {
  return steps.some((step) => step.kind === "prompt");
}

/** Last answer to each plain prompt, so a userid need only be typed once. */
const lastAnswers = new Map<string, string>();

/**
 * Ask for the values of any `[prompt]` steps and fold them into the macro.
 *
 * Everything is asked before the first key is typed, because the macro is
 * replayed as one batch on the session thread. Dismissing a box abandons the
 * whole macro rather than sending half a logon.
 */
export async function fillPrompts(
  name: string,
  steps: MacroStep[]
): Promise<MacroStep[] | undefined> {
  const filled: MacroStep[] = [];
  for (const step of steps) {
    if (step.kind !== "prompt") {
      filled.push(step);
      continue;
    }
    const value = await vscode.window.showInputBox({
      title: `Macro "${name}"`,
      prompt: step.label,
      value: step.secret ? undefined : lastAnswers.get(step.label),
      password: step.secret,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return undefined;
    }
    if (!step.secret) {
      lastAnswers.set(step.label, value);
    }
    filled.push({ kind: "text", value });
  }
  return filled;
}

/** Parse a named macro from settings. Returns undefined and warns on error. */
export function resolveMacro(name: string): MacroStep[] | undefined {
  const source = getMacros()[name];
  if (source === undefined) {
    void vscode.window.showWarningMessage(
      `TNZ 3270: no macro named "${name}" in tnzView.macros.`
    );
    return undefined;
  }
  try {
    const steps = parseMacro(source);
    if (!steps.length) {
      throw new MacroError("the macro is empty");
    }
    return steps;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `TNZ 3270: macro "${name}": ${message}`
    );
    return undefined;
  }
}
