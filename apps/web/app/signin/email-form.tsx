"use client";
import { useState } from "react";

export function EmailForm({ returnTo = "/settings", linking = false }: { returnTo?: string; linking?: boolean }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(action: "send" | "verify") {
    setBusy(true); setError("");
    try {
      const response = await fetch("/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, email, code, returnTo }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to continue. Please try again.");
      if (action === "send") { setSent(true); setCode(""); }
      else window.location.assign(result.destination);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={e => { e.preventDefault(); void submit(sent ? "verify" : "send"); }}>
    {!sent ? <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" disabled={busy} /></label>
      : <><p role="status">We sent a code to <strong>{email}</strong>. Check your inbox and spam folder.</p><label>8-digit verification code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{8}" required maxLength={8} value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label></>}
    {error && <p role="alert" className="field-hint error">{error}</p>}
    <button className="button" disabled={busy}>{busy ? "Please wait…" : sent ? linking ? "Verify and link email" : "Verify and continue" : linking ? "Send verification code" : "Continue with email"}</button>
    {sent && <div className="actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void submit("send")}>Resend code</button><button type="button" className="button secondary" disabled={busy} onClick={() => { setSent(false); setError(""); }}>Change email</button></div>}
    <p className="field-hint">No password needed. Codes expire after 10 minutes.</p>
  </form>;
}
