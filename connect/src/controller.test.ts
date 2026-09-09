import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "./controller.js";
import { loadConfig, saveConfig } from "../../packages/cli/src/config.js";
import { serverOrigin, sourceSelection } from "./policy.js";
const { keys } = vi.hoisted(() => ({ keys: new Map<string, string>() }));
vi.mock("../../packages/cli/src/keystore.js", () => ({
  saveKey: vi.fn(async (id, key) => { keys.set(id, key); }),
  loadKey: vi.fn(async id => { if (!keys.has(id)) throw new Error("missing"); return { privateKeyPem: keys.get(id), source: "keychain" }; }),
  deleteKey: vi.fn(async id => keys.delete(id)),
}));
let root: string, oldDir: string | undefined;
beforeEach(async () => { oldDir = process.env.USURP_CONFIG_DIR; root = await mkdtemp(join(tmpdir(), "usurp-service-unit-")); keys.clear(); });
afterEach(() => { if (oldDir === undefined) delete process.env.USURP_CONFIG_DIR; else process.env.USURP_CONFIG_DIR = oldDir; vi.unstubAllGlobals(); });
const options = { server: "https://usurp.example", agents: ["codex"], bridge: false, all: true, consent: true };
async function connected(runner = vi.fn(async (_options?: any) => ({ ok: true, uploaded: true, warnings: 0 }))) {
  const c = new Controller(root, runner); await c.init(); await c.action("save", options); await saveConfig({ apiUrl: options.server, seq: 1, deviceId: "dev_TEST", handle: "tester" }); keys.set("dev_TEST", "private"); return { c, runner };
}
describe("browser companion consent and recovery", () => {
  it("never collects before consent", async () => { const runner = vi.fn(); const c = new Controller(root, runner); await c.init(); await c.tick(); await c.runSync(); expect(runner).not.toHaveBeenCalled(); expect((await c.state()).paused).toBe(true); });
  it("requires sources and boolean consent", async () => { const c = new Controller(root); await c.init(); await expect(c.action("save", {...options, agents:[]})).rejects.toThrow("source"); await expect(c.action("save", {...options, consent:"yes"})).rejects.toThrow("Invalid"); });
  it("never treats no-data check as an upload", async () => { const {c} = await connected(vi.fn(async () => ({ok:true,uploaded:false,warnings:0}))); await c.runSync(); expect(c.prefs.lastAttempt).toBeTruthy(); expect(c.prefs.lastUpload).toBeUndefined(); expect(c.status).toContain("Nothing was uploaded"); });
  it("records confirmed uploads and imports history only once", async () => { const {c,runner} = await connected(); await c.runSync(); expect(c.prefs.lastUpload).toBeTruthy(); await c.runSync(); expect(runner.mock.calls[0]?.[0]).toEqual({ agents:["codex"],bridge:false,all:true }); expect(runner.mock.calls[1]?.[0]).toEqual({ agents:["codex"],bridge:false,all:false }); });
  it("persists pause across restarts", async () => { const {c} = await connected(); await c.runSync(); await c.action("pause"); const runner = vi.fn(); const restarted = new Controller(root,runner); await restarted.init(); await restarted.tick(); expect(restarted.prefs.paused).toBe(true); expect(restarted.prefs.lastUpload).toBeTruthy(); expect(runner).not.toHaveBeenCalled(); });
  it("resumes only with an enrolled device and existing source consent", async () => { const {c}=await connected();await c.action("pause");await c.action("resume");expect(c.prefs.paused).toBe(false);await c.action("disconnect");await expect(c.action("resume")).rejects.toThrow("approve sources"); });
  it("retries failure without marking the archive complete", async () => { const runner=vi.fn().mockResolvedValueOnce({ok:false,uploaded:false,warnings:0}).mockResolvedValue({ok:true,uploaded:true,warnings:0}); const {c}=await connected(runner); await c.runSync(); expect(c.prefs.imported).toBe(false); expect(c.prefs.lastUpload).toBeUndefined(); expect(c.nextSync).toBeGreaterThan(Date.now()+110000); c.nextSync=0; await c.tick(); await vi.waitFor(()=>expect(c.busy).toBe(false)); expect(c.prefs.lastUpload).toBeTruthy(); expect(c.failures).toBe(0); });
  it("blocks overlapping sync and prevents changing sources during upload", async () => { let finish!: (v:any)=>void; const runner=vi.fn(()=>new Promise<any>(r=>{finish=r;})); const {c}=await connected(runner); const pending=c.runSync(); await c.runSync(); await expect(c.action("save",options)).rejects.toThrow("current sync"); await c.action("pause"); finish({ok:true,uploaded:true,warnings:0}); await pending; expect(runner).toHaveBeenCalledTimes(1); expect(c.prefs.paused).toBe(true); });
  it("source changes reset the lookback and archive cursor", async () => { const {c}=await connected(); await c.runSync(); await saveConfig({...await loadConfig(),lastSyncAt:new Date().toISOString()}); await c.action("save",{...options,agents:["cursor"]}); expect(c.prefs.imported).toBe(false); expect((await loadConfig()).lastSyncAt).toBeUndefined(); });
  it("does not silently switch an enrolled deployment", async () => { const {c}=await connected(); await expect(c.action("save",{...options,server:"https://evil.example"})).rejects.toThrow("Disconnect"); });
  it("disconnect removes its key, not other device keys", async () => { const {c}=await connected(); keys.set("another-device","untouched"); await c.action("disconnect"); expect(keys.has("dev_TEST")).toBe(false); expect(keys.get("another-device")).toBe("untouched"); expect((await loadConfig()).deviceId).toBeUndefined(); expect(c.prefs.consent).toBe(false); });
  it("malformed preferences fail closed", async () => { await writeFile(join(root,"preferences.json"),JSON.stringify({...options,paused:"false"})); const c=new Controller(root); await c.init(); expect(c.prefs.consent).toBe(false); });
  it("pairs via browser approval, stores secrets in keyring, and never auto-consents", async () => {
    const code="ABCD-1234-5678",token="A".repeat(43); const request=vi.fn(async (_url,init)=>{const body=JSON.parse(init.body);return Response.json(body.action==="start"?{code,token,expiresAt:new Date(Date.now()+600000).toISOString()}:{status:"approved",deviceId:"dev_PAIRED",handle:"tester"});});vi.stubGlobal("fetch",request);
    const c=new Controller(root);await c.init();await c.action("pair");const state=await c.state();expect(JSON.stringify(state)).not.toContain(token);expect(state.pairing?.code).toBe(code);
    const restarted=new Controller(root);await restarted.init();await restarted.tick();expect((await loadConfig()).deviceId).toBe("dev_PAIRED");expect(restarted.prefs.consent).toBe(false);expect(keys.has("dev_PAIRED")).toBe(true);expect(JSON.stringify(await readFile(join(root,"device/config.json"),"utf8"))).not.toContain("PRIVATE KEY");
  });
  it("expires pending approval without enrolling", async () => { const c=new Controller(root);await c.init();c.pending={code:"ABCD-1234-5678",token:"A".repeat(43),publicKey:"test",expiresAt:new Date(0).toISOString(),server:options.server};await c.tick();expect(c.pending).toBeUndefined();expect((await loadConfig()).deviceId).toBeUndefined(); });
  it("validates server origins and source choices",()=>{ expect(serverOrigin("https://usurp.example/")).toBe("https://usurp.example");for(const v of ["http://remote.example","https://user:pass@site.example","https://site.example/path","https://site.example#token"])expect(()=>serverOrigin(v)).toThrow();expect(()=>sourceSelection(["codex","codex"])).toThrow();expect(()=>sourceSelection(["unknown"])).toThrow(); });
});
