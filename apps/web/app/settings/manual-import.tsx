"use client";
import { useState } from "react";
export function ManualImport() {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>Advanced: import aggregate JSON</summary>
      <p>
        Import a JSON object with a buckets array using the published hourly
        payload schema. Never upload transcripts or code. Manual records are
        unverified, excluded from competition, and skipped when an
        hour/model/tool is already present.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setMessage("");
          const data = new FormData(event.currentTarget);
          try {
            const file = data.get("file");
            if (!(file instanceof File) || file.size > 1024 * 1024)
              throw new Error("Select a JSON file no larger than 1 MB.");
            const payload = JSON.parse(await file.text());
            const response = await fetch("/v1/me/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...payload,
                consent: data.get("consent") === "on",
              }),
            });
            const result = await response.json();
            if (!response.ok)
              throw new Error(result.error || "The import failed validation.");
            setMessage(
              `Imported ${result.accepted} records; skipped ${result.skipped ?? 0} existing records. View All time in your usage profile.`,
            );
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Import failed.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Aggregate JSON file
          <input
            type="file"
            name="file"
            accept=".json,application/json"
            required
            disabled={busy}
          />
        </label>
        <label>
          <input type="checkbox" name="consent" required disabled={busy} /> I
          have reviewed these aggregate counters and want to upload them.
        </label>
        <button className="button secondary" disabled={busy}>
          {busy ? "Importing…" : "Import unverified usage"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
