"use client";
import { useState } from "react";
type Org = { id: string; name: string; domain: string; verified: boolean };
export function Organizations({ initial }: { initial: Org[] }) {
  const [orgs, setOrgs] = useState(initial),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{
    record: string;
    value: string;
  } | null>(null);
  const [aggregate, setAggregate] = useState<string | null>(null);
  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Please retry.");
    return result;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" id="organizations">
      <h2>Organizations</h2>
      <p>
        Verify domain ownership with DNS. Members must verify a work email and
        explicitly join; they start hidden. Domain ownership does not give
        anyone a gold usage-verification badge.
      </p>
      <details>
        <summary>Create an organization</summary>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const result = await post("/v1/orgs", {
                name: data.get("name"),
                domain: data.get("domain"),
                consent: data.get("consent") === "on",
              });
              setChallenge({ record: result.record, value: result.value });
              setOrgs([
                ...orgs,
                {
                  id: result.arena.id,
                  name: result.arena.name,
                  domain: String(data.get("domain")),
                  verified: false,
                },
              ]);
            });
          }}
        >
          <label className="field">
            Organization name
            <input
              className="input"
              name="name"
              required
              minLength={2}
              maxLength={48}
            />
          </label>
          <label className="field">
            Work email domain
            <input
              className="input"
              name="domain"
              placeholder="company.com"
              required
              maxLength={253}
            />
          </label>
          <label>
            <input type="checkbox" name="consent" required /> I agree to
            aggregate-only administration and voluntary member participation.
          </label>
          <button className="button" disabled={busy}>
            Create and get DNS record
          </button>
        </form>
      </details>
      {challenge && (
        <div role="status">
          <p>
            Add this TXT record within seven days. Keep the value before leaving
            this page.
          </p>
          <pre>
            {challenge.record}
            {"\n"}
            {challenge.value}
          </pre>
        </div>
      )}
      {orgs.map((org) => (
        <div className="card" key={org.id}>
          <h3>{org.name}</h3>
          <p>
            {org.domain} ·{" "}
            {org.verified ? "Domain verified" : "DNS verification pending"}
          </p>
          <p>
            Organization ID: <code>{org.id}</code>
          </p>
          {!org.verified && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setChallenge(await post(`/v1/orgs/${org.id}/challenge`, {}));
                  setNotice(
                    "New DNS record created. The previous value no longer works.",
                  );
                })
              }
            >
              Replace lost or expired DNS record
            </button>
          )}
          {!org.verified ? (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post(`/v1/orgs/${org.id}/verify`, {});
                  setOrgs(
                    orgs.map((o) =>
                      o.id === org.id ? { ...o, verified: true } : o,
                    ),
                  );
                  setNotice(
                    "Domain verified. Members can now join with a verified work email.",
                  );
                })
              }
            >
              Check DNS verification
            </button>
          ) : (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const response = await fetch(`/v1/orgs/${org.id}/aggregate`);
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error);
                  setAggregate(
                    result.suppressed
                      ? "Last completed UTC week: report withheld until at least five members contributed after joining."
                      : `Last completed UTC week: ${result.tokens} effective tokens; ${(Number(result.costMicros) / 1e6).toFixed(2)} USD reader-reported cost (may include estimates).${result.costComplete ? "" : " Cost is incomplete: some activity has no price."}`,
                  );
                })
              }
            >
              View weekly aggregate
            </button>
          )}
        </div>
      ))}
      {aggregate && <p role="status">{aggregate}</p>}
      <details>
        <summary>Join with an organization ID</summary>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              await post(
                `/v1/orgs/${encodeURIComponent(String(data.get("id")))}/join`,
                { consent: data.get("consent") === "on" },
              );
              window.location.reload();
            });
          }}
        >
          <label className="field">
            Organization ID
            <input className="input" name="id" required maxLength={36} />
          </label>
          <p>
            First link your work email in Account security. You can belong to
            one organization at a time.
          </p>
          <label>
            <input type="checkbox" name="consent" required /> Include my
            activity after joining in organization totals. Keep my individual
            activity hidden unless I change visibility.
          </label>
          <button className="button" disabled={busy}>
            Join privately
          </button>
        </form>
      </details>
      {notice && <p role="status">{notice.replaceAll("_", " ")}</p>}
    </section>
  );
}
