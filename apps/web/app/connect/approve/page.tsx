import { redirect } from "next/navigation";
import { decidePairing, getDb, inspectPairing } from "@usurp/db";
import { currentUser } from "../../../lib/session";

async function decide(form: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/signin");
  const code = String(form.get("code") ?? "");
  const approve = form.get("decision") === "approve";
  if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) redirect("/connect/approve?result=expired");
  const ok = await decidePairing(getDb(), code, user.id, approve);
  redirect(`/connect/approve?result=${!ok ? "expired" : approve ? "approved" : "denied"}`);
}

export default async function ApprovePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : "";
  const user = await currentUser();
  if (!user) redirect(`/signin?return_to=${encodeURIComponent(`/connect/approve?code=${encodeURIComponent(code)}`)}`);
  if (params.result) return <main className="wrap narrow"><section className="signin-card"><p className="eyebrow">Usurp Connect</p><h1>{params.result === "approved" ? "Computer connected." : params.result === "denied" ? "Connection declined." : "Request no longer available."}</h1><p>{params.result === "approved" ? "Return to Usurp Connect to choose your sources and start syncing. You have not joined a public board." : "You can start a new request from Usurp Connect."}</p><a className="button" href="/settings#devices">Manage devices</a></section></main>;
  const pairing = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code) ? await inspectPairing(getDb(), code) : undefined;
  if (!pairing) return <main className="wrap narrow"><h1>This connection request has expired.</h1><p>Start again from Usurp Connect on your computer.</p><a href="/connect">Back to Connect</a></main>;
  return <main className="wrap narrow"><section className="signin-card"><p className="eyebrow">Approve this computer</p><h1>Is this your code?</h1><p>Only approve a request you just started in Usurp Connect. Never approve a code someone sent you.</p><pre style={{ fontSize: "1.8rem", textAlign: "center" }}>{code}</pre><p>Connect <strong>{pairing.label}</strong> to <strong>@{user.handle}</strong>.</p><p className="field-hint">Key fingerprint: {pairing.fingerprint}. Compare this with the app if you are unsure.</p><p>The computer can upload signed usage summaries. It cannot read your account or sign you in. Prompts and source code stay local. Global membership is a separate opt-in.</p><form action={decide}><input type="hidden" name="code" value={code}/><div className="actions"><button className="button" name="decision" value="approve">Yes, connect this computer</button><button className="button secondary" name="decision" value="deny">Decline</button></div></form></section></main>;
}
