"use client";

/**
 * "Add a device" — mints an enrollment code and shows it once.
 *
 * A client component rather than a Server Action on purpose. An action would
 * have to hand the code back through a redirect or a cookie, and a single-use
 * credential in a URL ends up in browser history, the referer header, and any
 * proxy log along the way. Fetching it and rendering it in place keeps it out
 * of all three.
 */

import { useState } from "react";

interface Issued {
  code: string;
  expires_at: string;
  command: string;
}

export default function EnrollButton() {
  const [issued, setIssued] = useState<Issued | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setPending(true);
    setError(undefined);
    setCopied(false);
    try {
      const response = await fetch("/v1/me/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Your session expired. Reload and sign in again."
            : `Could not create a code (HTTP ${response.status}).`,
        );
        return;
      }
      setIssued((await response.json()) as Issued);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access is denied in plenty of contexts; the code is visible
      // on screen either way, so this is not worth an error message.
    }
  }

  if (issued) {
    const expires = new Date(issued.expires_at);
    return (
      <div className="issued">
        <p className="field-label">
          Run this from the Usurp source directory on the machine you want to enrol
        </p>
        <pre>
          <code>{issued.command}</code>
        </pre>
        <div className="row">
          <button className="button secondary" type="button" onClick={() => copy(issued.command)}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="button ghost" type="button" onClick={() => setIssued(undefined)}>
            Done
          </button>
        </div>
        <p className="field-hint">
          Valid until {expires.toISOString().slice(11, 16)} UTC (
          {Math.max(0, Math.round((expires.getTime() - Date.now()) / 60000))} min).
          Single use, and shown only once — we store only its hash.
        </p>
      </div>
    );
  }

  return (
    <div>
      <button className="button" type="button" onClick={mint} disabled={pending}>
        {pending ? "Creating…" : "Add a device"}
      </button>
      {error && <p className="field-hint error">{error}</p>}
    </div>
  );
}
