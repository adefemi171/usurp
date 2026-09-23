import { getDb, outcomeBoard } from "@usurp/db";
import { trustedAttestors } from "@usurp/protocol";

export const dynamic = "force-dynamic";
export default async function OutcomeArena() {
  const keys = trustedAttestors(process.env.USURP_TRUSTED_OUTCOME_KEYS);
  const rows = await outcomeBoard(getDb(), keys);
  return <main className="wrap"><section className="settings-section"><p className="eyebrow">Outcome arena</p><h1>Verified outcomes</h1>
    <p>Successful missions reported by approved attestors. Each completed mission earns 100 points, counted once even after retries. These results describe checks, not task difficulty or overall developer skill.</p>
    <p>Only explicitly shared results from active, visible Global members appear. Local signatures authenticate the reporter; an arena operator must independently approve a CI or test attestor before its results qualify.</p>
    <p><a href="/settings#attestors">Manage attestors</a> · <a href="/connect#outcome-verification">Offline setup</a> · <a href="/?metric=rating#arena">Rating &amp; Burn</a></p>
    {!keys.length ? <p>No independent attestors have been configured on this deployment yet.</p> : !rows.length ? <p>No eligible outcomes have been shared yet.</p> : <div className="table-scroll"><table className="board"><thead><tr><th>Rank</th><th>Member</th><th>Score</th><th>Completed missions</th><th>Completion rate</th></tr></thead><tbody>{rows.map((r, i) => <tr key={r.name}><td>{i + 1}</td><td>{r.name}</td><td>{r.score}</td><td>{r.completed} / {r.attempted}</td><td>{r.completionRate}%</td></tr>)}</tbody></table></div>}
  </section></main>;
}
