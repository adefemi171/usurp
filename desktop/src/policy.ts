export const AGENTS = ["claude-code", "codex", "cursor", "vscode-copilot"];
export function serverOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter your Usurp website address.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a complete website address, such as https://usurp.onrender.com."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS website origin, or localhost for development.");
  return url.origin;
}
export function sourceSelection(input: unknown): string[] {
  if (!Array.isArray(input) || input.some(value => !AGENTS.includes(value)) || new Set(input).size !== input.length) throw new Error("Invalid source selection.");
  return input;
}
export function deepLinkServer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "usurp-connect:" || url.hostname !== "open" || (url.pathname && url.pathname !== "/") || url.username || url.password) throw new Error("Invalid Connect link.");
  return serverOrigin(url.searchParams.get("server"));
}
