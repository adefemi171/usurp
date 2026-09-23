import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalBytes, generateDeviceKeyPair, publicKeyFromPem, signBytes } from "../../packages/protocol/src/index.js";
import { signOutcome, signedOutcomeSchema, experimentSummary, type SignedOutcome } from "../../packages/protocol/src/outcomes.js";
import { loadKey, saveKey } from "../../packages/cli/src/keystore.js";
import { serverOrigin } from "./policy.js";

const uuid = z.string().uuid();
const missionSchema = z.object({ id: uuid, label: z.string().min(2).max(80), budgetUsd: z.number().min(0).max(10000), maxRuns: z.number().int().min(1).max(999), createdAt: z.string().datetime(), experimentId: uuid.optional(), variant: z.enum(["baseline", "intervention"]).optional() }).strict();
export async function readOutcomes(directory: string): Promise<SignedOutcome[]> {
  const folder = join(directory, "outcomes");
  let files: string[];
  try { files = await readdir(folder); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  return Promise.all(files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(async f => signedOutcomeSchema.parse(JSON.parse(await readFile(join(folder, f), "utf8")))));
}
export async function storeOutcome(directory: string, value: SignedOutcome) {
  const parsed = signedOutcomeSchema.parse(value);
  await mkdir(join(directory, "outcomes"), { recursive: true, mode: 0o700 });
  const temporary = join(directory, "outcomes", `${parsed.outcome.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(parsed), { flag: "wx", mode: 0o600 });
  const { link } = await import("node:fs/promises");
  try { await link(temporary, join(directory, "outcomes", `${parsed.outcome.id}.json`)); } finally { await unlink(temporary); }
}
export async function outcomeSyncPreference(directory: string): Promise<{ enabled: boolean; server: string }> {
  try { return z.object({ enabled: z.boolean(), server: z.string() }).parse(JSON.parse(await readFile(join(directory, "outcome-sync.json"), "utf8"))); }
  catch { return { enabled: false, server: "https://usurp.onrender.com" }; }
}
export async function saveOutcomeSyncPreference(directory: string, enabled: boolean, server: string) {
  const value = { enabled, server: serverOrigin(server) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `outcome-sync-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, join(directory, "outcome-sync.json"));
}
/** Retries retain the original immutable ID and signature; acknowledgements are per server. */
export async function syncOutcomes(directory: string, server: string, request: typeof fetch = fetch, shouldContinue: () => Promise<boolean> = async () => true) {
  const origin = serverOrigin(server);
  const folder = join(directory, "receipts", createHash("sha256").update(origin).digest("hex"));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let sent = 0;
  for (const value of await readOutcomes(directory)) {
    if (!await shouldContinue() || sent >= 100) break;
    try { await readFile(join(folder, value.outcome.id)); continue; } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const response = await request(`${origin}/v1/outcomes`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    if (!response.ok) throw new Error(`Outcome sync returned ${response.status}. Records remain local. Link this attestor in Settings and retry.`);
    const result = await response.json();
    if (result.accepted !== value.outcome.id) throw new Error("Invalid acknowledgement; record retained for retry.");
    await writeFile(join(folder, value.outcome.id), "accepted", { mode: 0o600 }); sent++;
  }
  return sent;
}
async function identity(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "outcome-key.lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try { return await unlockedIdentity(directory); } finally { await unlink(lock); }
}
async function unlockedIdentity(directory: string) {
  const account = `outcomes-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`;
  const marker = join(directory, "outcome-key.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let publicKey: string | undefined;
  try { publicKey = JSON.parse(await readFile(marker, "utf8")).publicKey; } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  let privateKeyPem: string;
  if (publicKey || process.env.USURP_DEVICE_KEY) privateKeyPem = (await loadKey(account)).privateKeyPem;
  else {
    // Recover a key saved before a crash, before generating a new identity.
    try { privateKeyPem = (await loadKey(account)).privateKeyPem; }
    catch { const keys = generateDeviceKeyPair(); await saveKey(account, keys.privateKeyPem); privateKeyPem = keys.privateKeyPem; }
  }
  const derived = publicKeyFromPem(privateKeyPem);
  if (publicKey && publicKey !== derived) throw new Error("Outcome key mismatch. Use the original key or another data directory.");
  if (!publicKey) await writeFile(marker, JSON.stringify({ publicKey: derived }), { flag: "wx", mode: 0o600 });
  return { publicKey: derived, privateKeyPem };
}
export function prPassed(data: any): boolean {
  return typeof data?.mergedAt === "string" && Number.isFinite(Date.parse(data.mergedAt)) && Array.isArray(data.statusCheckRollup) && data.statusCheckRollup.length > 0 && data.statusCheckRollup.every((c: any) => c?.__typename === "CheckRun" ? c.status === "COMPLETED" && c.conclusion === "SUCCESS" : c?.__typename === "StatusContext" && c.state === "SUCCESS");
}
export async function outcomeCommand(args: string[], directory: string): Promise<number> {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const option = (name: string) => { const i = flags.indexOf(name); return i < 0 ? undefined : flags[i + 1]; };
  const command = args[0];
  if (command === "attest-sync") { console.log(`Synced ${await syncOutcomes(directory, option("--server") ?? "https://usurp.onrender.com")} outcomes.`); return 0; }
  if (command === "attestor-link") {
    const owner = uuid.parse(option("--owner"));
    const keys = await identity(directory);
    const claim = { purpose: "usurp-outcome-link-v1", owner, publicKey: keys.publicKey };
    console.log(JSON.stringify({ ...claim, signature: signBytes(canonicalBytes(claim), keys.privateKeyPem) })); return 0;
  }
  if (command === "mission-start") {
    const mission = missionSchema.parse({ id: option("--id") ?? randomUUID(), label: option("--label") ?? "Local check", budgetUsd: Number(option("--budget") ?? 2), maxRuns: Number(option("--max-runs") ?? 5), createdAt: new Date().toISOString(), ...(option("--experiment") ? { experimentId: option("--experiment"), variant: option("--variant") } : {}) });
    if (!!mission.experimentId !== !!mission.variant) throw new Error("Supply --experiment UUID and --variant baseline|intervention together.");
    await mkdir(join(directory, "missions"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "missions", `${mission.id}.json`), JSON.stringify(mission), { flag: "wx", mode: 0o600 });
    console.log(mission.id); return 0;
  }
  if (command === "mission-list") {
    let files: string[] = [];
    try { files = await readdir(join(directory, "missions")); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const results = await readOutcomes(directory);
    for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const mission = missionSchema.parse(JSON.parse(await readFile(join(directory, "missions", file), "utf8")));
      console.log(JSON.stringify({ ...mission, results: results.filter(r => r.outcome.missionId === mission.id).map(r => r.outcome) }));
    }
    return 0;
  }
  if (command === "experiment-report") {
    const experimentId = uuid.parse(option("--experiment"));
    console.log(JSON.stringify(experimentSummary((await readOutcomes(directory)).map(r => r.outcome).filter(r => r.experimentId === experimentId)), null, 2));
    console.log("Observed check durations and pass rates; compare similar tasks. This is not causal evidence or measured AI cost savings."); return 0;
  }
  const missionId = uuid.parse(option("--mission"));
  const mission = missionSchema.parse(JSON.parse(await readFile(join(directory, "missions", `${missionId}.json`), "utf8")));
  // One check at a time per mission. A crashed process leaves an inspectable lock.
  const lock = join(directory, "missions", `${missionId}.lock`);
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const previous = (await readOutcomes(directory)).filter(r => r.outcome.missionId === missionId);
    if (previous.length >= mission.maxRuns) throw new Error("Mission check limit reached. Start a new mission to continue.");
    const keys = await identity(directory);
    const startedAt = new Date().toISOString();
    let passed = false;
    // Neither test commands nor the GitHub adapter receive Usurp credentials.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("USURP_")));
    const kind = command === "attest-pr" ? "pr" : option("--kind") ?? "test";
    if (!["test", "ci", "pr"].includes(kind) || (command !== "attest-pr" && kind === "pr")) throw new Error("Invalid attestation kind.");
    if (command === "attest-pr") {
      const url = option("--pr");
      if (!url || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url)) throw new Error("Supply --pr with a github.com pull request URL. This check requires GitHub connectivity.");
      // Reference and response stay local; transport failures produce no result.
      try { const { stdout } = await promisify(execFile)("gh", ["pr", "view", url, "--json", "mergedAt,statusCheckRollup"], { env, timeout: 30000, maxBuffer: 1048576 }); passed = prPassed(JSON.parse(stdout)); }
      catch { throw new Error("GitHub check unavailable. No attestation recorded; retry with connectivity and gh authentication."); }
    } else {
      const argv = separator < 0 ? [] : args.slice(separator + 1);
      if (!argv.length) throw new Error("Supply a test command after --.");
      const timeout = Number(option("--timeout-seconds") ?? 600);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new Error("Timeout must be 1–86400 seconds.");
      passed = await new Promise<boolean>(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), { shell: false, stdio: "inherit", env, timeout: timeout * 1000, killSignal: "SIGKILL" });
        child.once("error", () => resolve(false)); child.once("close", code => resolve(code === 0));
      });
    }
    const finishedAt = new Date().toISOString();
    const signed = signOutcome({ version: 1, id: randomUUID(), missionId, publicKey: keys.publicKey, kind: kind as "test" | "ci" | "pr", passed, startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt), ...(mission.experimentId ? { experimentId: mission.experimentId, variant: mission.variant } : {}) }, keys.privateKeyPem);
    await storeOutcome(directory, signed);
    console.log(`Recorded ${passed ? "pass" : "fail"} locally: ${signed.outcome.id}. Sharing follows your explicit sync choices.`);
    return passed ? 0 : 1;
  } finally { await unlink(lock); }
}
