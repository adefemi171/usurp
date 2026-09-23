import { eq, desc } from "drizzle-orm";
import { getDb, outcomeAttestors, outcomeReceipts } from "@usurp/db";
import { trustedAttestors, experimentSummary } from "@usurp/protocol";
import { linkAttestor, changeAttestor } from "./attestor-actions";

export async function Attestors({ userId }: { userId: string }) {
  const db = getDb();
  const [keys, recent] = await Promise.all([
    db.select().from(outcomeAttestors).where(eq(outcomeAttestors.userId, userId)),
    db.select({ payload: outcomeReceipts.payload }).from(outcomeReceipts).innerJoin(outcomeAttestors, eq(outcomeAttestors.publicKey, outcomeReceipts.publicKey)).where(eq(outcomeAttestors.userId, userId)).orderBy(desc(outcomeReceipts.receivedAt)).limit(20),
  ]);
  const trusted = trustedAttestors(process.env.USURP_TRUSTED_OUTCOME_KEYS);
  const experiments = [...new Set(recent.map(r => r.payload.outcome.experimentId).filter(Boolean))];
  return <section className="settings-section" id="attestors"><h2>Outcome verification</h2>
    <p>Run checks and keep signed results offline with Connect. Link the local key here when you want to upload. <a href="/connect#outcome-verification">Setup instructions</a></p>
    <pre><code>{`usurp-connect attestor-link --owner ${userId}`}</code></pre>
    <form className="form" action={linkAttestor}><label className="field">Paste the linking proof<textarea className="input" name="proof" required maxLength={1024} /></label><button className="button">Link attestor privately</button></form>
    {keys.map(key => <div className="card" key={key.publicKey}><p><code>{key.publicKey}</code></p><p>{key.revokedAt ? "Revoked" : trusted.includes(key.publicKey) ? "Approved independent attestor" : "Local signed reporter"} · {key.share ? "Sharing enabled" : "Private"}</p>{!key.revokedAt && <form className="row" action={changeAttestor}><input type="hidden" name="key" value={key.publicKey} /><button className="button secondary" name="action" value={key.share ? "private" : "share"}>{key.share ? "Keep private" : "Share eligible outcome totals"}</button><button className="button secondary" name="action" value="revoke">Revoke attestor</button></form>}</div>)}
    <p className="field-hint">Public sharing also requires visible Global membership and independent attestor approval. Revocation immediately removes this key’s results from the outcome arena. Upload retries never add extra points.</p>
    {!!recent.length && <details><summary>Recent uploaded checks ({recent.length})</summary><ul>{recent.map(({ payload: { outcome: o } }) => <li key={o.id}>{o.kind} · {o.passed ? "passed" : "failed"} · {o.finishedAt} · {(o.durationMs / 1000).toFixed(1)} s · mission <code>{o.missionId}</code></li>)}</ul></details>}
    {!!experiments.length && <details><summary>Coaching experiments in the last 20 uploads</summary>{experiments.map(id => { const result = experimentSummary(recent.map(r => r.payload.outcome).filter(o => o.experimentId === id)); return <p key={id}><code>{id}</code>: baseline {result.baseline.passed}/{result.baseline.trials} passes; intervention {result.intervention.passed}/{result.intervention.trials} passes. {result.durationChangePercent === null ? "Need at least three trials per group and successful timing data." : `Successful check duration changed ${result.durationChangePercent}%. ${result.qualityMaintained ? "Pass rate held or improved. Keep testing on comparable tasks." : "Pass rate declined; investigate before adopting this change."}`} Use the local experiment report for the full history. This does not measure agent cost savings.</p>; })}</details>}
    <a href="/outcomes">View verified-outcome arena</a>
  </section>;
}
