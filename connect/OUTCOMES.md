# Offline verification and the outcome arena

Connect can create missions, execute checks, sign their result, and compare experiments without an account or internet. Installation must already be available. Tests that download dependencies still require their own network access; Usurp does not make them offline. GitHub PR state inherently requires contacting GitHub.

## Local workflow

```sh
usurp-connect mission-start --label "Fix failing check" --budget 2 --max-runs 5
usurp-connect attest --mission PRINTED_UUID -- npm test
usurp-connect mission-list
```

`attest` wraps an explicitly supplied command without shell interpretation and preserves failure as exit code 1. Command output stays in your terminal. A timeout (600 seconds by default, configurable with `--timeout-seconds`) records failure. The signing key is excluded from the child's environment. The run limit applies to check executions, not agent turns. The USD budget is a planning target, not enforced spend or measured task cost. Runeward can enforce agent policies separately.

All commands accept `--data-dir PATH`. Mission labels and parameters stay in that directory. Signed proofs contain only opaque IDs, test/CI/PR kind, pass/fail, start/end time, duration, optional experiment grouping and the public key. Keys use the OS keychain; headless installations supply `USURP_DEVICE_KEY` as an Ed25519 PKCS#8 PEM through a secret manager. A headless machine without a key or keyring cannot sign, but it can create missions. Never place a private key in source control, artifacts or command arguments.

Records survive restarts. Publishing creates a separate acknowledgement per server; a lost response is safely retried with the original record ID. Proofs are never deleted by sync. An interrupted check may leave a `missions/UUID.lock` file or `outcome-key.lock` containing its process ID; after confirming that process is gone, remove that exact lock to resume. Unfinished checks have no result and cannot earn points.

## Link and sync by consent

Website Settings → Outcome verification supplies an account UUID:

```sh
usurp-connect attestor-link --owner ACCOUNT_UUID
```

Paste the printed public proof into Settings. It binds possession of the key to that account. A key cannot be reassigned after linking, including after revocation. Then:

```sh
usurp-connect attest-sync --server https://YOUR_USURP
```

For automatic offline recovery, open the local browser controls and enable Outcome sharing for your chosen server. It retries about once a minute while the service runs. This permission is separate from usage syncing and public arena sharing. Disable it to prevent subsequent uploads; one already in flight may finish. A purely local installation needs neither linking nor sync. A self-hosted server on localhost is supported.

Local missions are independent of website Operator Runs. To refer to an existing website run, create a local mission using its UUID with `mission-start --id UUID`; checks are still separate signed receipts and never turn manually entered budget claims into verified spending.

## CI and PR verification

Any CI runner can execute `attest --kind ci --mission UUID -- COMMAND`. It observes the command result automatically. Keep the signing key in a protected CI context controlled by the attestor operator.

This repository includes `.github/workflows/outcome-attestation.yml`. It runs after **Verify Usurp**, accepts only completed push runs from this repository's main branch, and signs the upstream workflow conclusion. It does not execute fork PR code with attestor secrets. Configure:

- `USURP_OUTCOME_KEY` secret: a dedicated CI signing key, provisioned by the operator.
- `USURP_OUTCOME_SERVER` variable: destination origin.
- `USURP_OUTCOME_OWNER` variable: the account UUID from Settings.

The first configured run prints a public linking proof; link it before replaying sync. It saves signed queue files as a short-lived GitHub artifact for recovery. Download them into an outcome data directory's `outcomes/` folder and run `attest-sync`. These artifacts contain only the public proof fields. No secrets have been provisioned or access granted by adding the workflow. An unconfigured workflow reports that status and sends nothing.

For PR checks:

```sh
usurp-connect attest-pr --mission UUID --pr https://github.com/OWNER/REPO/pull/NUMBER
```

This uses the installed, authenticated GitHub CLI to read `mergedAt,statusCheckRollup`. A pass requires a merged PR, at least one check, and success for every returned check. Empty, pending, skipped or failed checks cannot pass. Connectivity/authentication errors save no attestation; retry when connected. The URL and API response are never uploaded. This verifies the returned rollup, not branch-protection policy or test adequacy. See [GitHub CLI's field documentation](https://cli.github.com/manual/gh_pr_view).

## Trust and scoring

A valid signature authenticates a reporter; a user controlling a local key can manufacture a result. Local results therefore remain private practice data unless an operator independently approves the key. Set `USURP_TRUSTED_OUTCOME_KEYS` on the server to comma-separated public keys of independently managed runners only. Do not approve arbitrary user-controlled laptops or CI keys available to untrusted job code.

The `/outcomes` arena requires all of: approved key, unrevoked link, explicit result-sharing consent, active Global membership, visible membership, and clear account review state. Anonymous visibility uses the existing pseudonym. Key removal from the approved list or revocation immediately removes its results on the next read.

Each distinct successful mission earns 100 points regardless of retries. Completion rate shows completed/attempted missions; retries do not add extra completed missions. Approving an attestor delegates judgment about meaningful checks, mission identity, and prevention of manufactured missions to its operator. Scores do not compare task difficulty, certify business outcomes, or infer AI productivity. CI uses a stable opaque mission ID per upstream workflow run. No repository identities or task labels are public.

## Measured coaching experiments

Generate an experiment UUID locally, then create comparable missions with `--experiment UUID --variant baseline` and `--variant intervention`. Change one workflow habit, such as using a saved project command. Each check records its observed duration and success.

```sh
usurp-connect experiment-report --experiment UUID
```

The report requires at least three trials per group before comparing successful-check durations, and separately shows pass rates so quicker failures cannot look like improvement. A lower pass rate prompts investigation. Settings shows a comparison for the latest 20 uploaded proofs; the local report uses all local results. This is observational feedback, not randomized causal inference, RL, or measured token savings. Whole-account token totals cannot reliably be attributed to concurrent missions, so they do not enter outcome scores.

## Deployment and limits

Apply migration `0015` before serving the new settings page or ingest endpoint. Proof IDs are immutable, conflicting replays fail, signatures cover every field, unlinked/revoked keys fail, and unknown fields are rejected. Account deletion cascades to attestors and receipts. Store deployment signing secrets separately from the public allowlist.

GitHub App/OIDC verification, protected-runner provisioning, provider-specific billing attribution, task-difficulty normalization, and independent test-adequacy evaluation are not implemented. The explicit attestor approval boundary is required for this release's shared arena.
