/**
 * Terminal output helpers.
 *
 * `usurp sync` runs from a `SessionEnd` hook, so its normal output has to be
 * quiet enough to sit at the end of someone's session without being noise.
 * Colour is disabled when not a TTY, when `NO_COLOR` is set, or when `TERM` is
 * `dumb` — a hook's output is frequently captured, and escape codes in a log
 * file are worse than no colour.
 */

const enabled =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.env.CI !== "true";

const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/**
 * Where human-readable output goes.
 *
 * Normally stdout. Commands whose stdout *is* the payload — `login
 * --print-key`, `preview --json` — switch this to stderr so that redirecting
 * stdout to a file captures only the data and none of the commentary.
 */
let out: NodeJS.WriteStream = process.stdout;

/** Send all informational output to stderr, reserving stdout for data. */
export function reserveStdoutForData(): void {
  out = process.stderr;
}

export function info(message: string): void {
  out.write(`${message}\n`);
}

export function success(message: string): void {
  out.write(`${green("✓")} ${message}\n`);
}

export function warn(message: string): void {
  out.write(`${yellow("!")} ${message}\n`);
}

/** Errors go to stderr so a hook's stdout stays parseable. */
export function error(message: string, hint?: string): void {
  process.stderr.write(`${red("✗")} ${message}\n`);
  if (hint) process.stderr.write(`  ${dim(hint)}\n`);
}

export function compactNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}
