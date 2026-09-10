"use client";
import { useState } from "react";

export function DeleteAccount({ handle }: { handle: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <details>
      <summary>Delete my account and usage</summary>
      <p>
        This permanently removes your profile, sign-in identities, devices,
        usage, imported snapshots, and memberships. Pending duels are cancelled.
        Other members’ accounts and clubs remain. This cannot be undone.
      </p>
      <p>
        Encrypted backups expire according to the deployment’s retention policy;
        deletion does not erase files on your computer.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const confirmation = new FormData(event.currentTarget).get(
            "confirmation",
          );
          try {
            const response = await fetch("/v1/me", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ confirmation }),
            });
            const result = await response.json();
            if (!response.ok)
              throw new Error(result.error || "Deletion failed. Please retry.");
            window.location.assign("/signin?deleted=1");
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Deletion failed.",
            );
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Type {handle} to confirm
          <input
            className="input"
            name="confirmation"
            required
            autoComplete="off"
            maxLength={32}
            disabled={busy}
          />
        </label>
        <button className="button danger" disabled={busy}>
          {busy ? "Deleting…" : "Permanently delete my account"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
