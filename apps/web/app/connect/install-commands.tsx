"use client";
import { useState } from "react";
export function InstallCommands({ packageUrl, server }: { packageUrl: string; server: string }) {
  const [copied, setCopied] = useState(false);
  const safe = (v: string) => JSON.stringify(v).replace(/[$`]/g, "\\$&");
  const commands = `npm install --global ${safe(packageUrl)}\nusurp-connect --server ${safe(server)}`;
  return <><pre><code>{commands}</code></pre><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(commands); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy setup commands"}</button><span role="status" className="field-hint">{copied ? " Commands copied." : ""}</span><details className="auth-options"><summary>Permission error installing globally? (Mac / Linux)</summary><p>Use this user-local installation instead. No sudo needed.</p><pre><code>{`npm install --prefix "$HOME/.local/share/usurp-connect" ${safe(packageUrl)}\n"$HOME/.local/share/usurp-connect/node_modules/.bin/usurp-connect" --server ${safe(server)}`}</code></pre><p>Use the full quoted executable path above to reopen controls or run status/stop.</p></details></>;
}
