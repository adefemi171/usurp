import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { runDemo } from "./render-demo.mjs";

function setup() {
  const runtime = Object.assign(new EventEmitter(), { execPath: process.execPath, env: { PORT: "10000" } });
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
  const spawnProcess = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }) });
    children.push(child);
    return child;
  });
  return { runtime, children, spawnProcess };
}
describe("Render free demo supervisor", () => {
  it("waits for migrations, then runs the web and worker on the configured port", async () => {
    const s = setup(); const done = runDemo(s);
    expect(s.spawnProcess).toHaveBeenCalledTimes(1);
    s.children[0]!.emit("close", 0);
    await Promise.resolve();
    expect(s.spawnProcess).toHaveBeenCalledTimes(3);
    expect(s.spawnProcess.mock.calls[1]![1]).toContain("10000");
    s.runtime.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(s.children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(s.children[2]!.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("does not serve when a migration fails", async () => {
    const s = setup(); const done = runDemo(s); s.children[0]!.emit("close", 1);
    expect(await done).toBe(1); expect(s.spawnProcess).toHaveBeenCalledTimes(1);
  });
  it("stops the web process if its worker exits", async () => {
    const s = setup(); const done = runDemo(s); s.children[0]!.emit("close", 0); await Promise.resolve();
    s.children[2]!.emit("close", 1);
    expect(await done).toBe(1); expect(s.children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("stops during migration without launching any services", async () => {
    const s = setup(); const done = runDemo(s); s.runtime.emit("SIGTERM");
    expect(await done).toBe(0); expect(s.spawnProcess).toHaveBeenCalledTimes(1);
  });
});
