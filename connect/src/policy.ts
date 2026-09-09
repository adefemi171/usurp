export const AGENTS = ["claude-code", "codex", "cursor", "vscode-copilot"];
export function serverOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter your Usurp website address.");
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS website origin (localhost is allowed for testing).");
  return url.origin;
}
export function sourceSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => !AGENTS.includes(v)) || new Set(value).size !== value.length) throw new Error("Invalid source selection.");
  return value;
}
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("USURP_") && !["NODE_OPTIONS", "NODE_PATH", "CONNECT_DATA_DIR"].includes(key)));
}
