import { afterEach, describe, expect, it, vi } from "vitest";
import {
  httpTransport,
  type Channel,
  type NotificationPayload,
} from "./notifications.js";

const channel = { kind: "email", target: "verified@example.com" } as Channel;
const payload = {
  text: "Someone took the Throne.",
  url: "https://example.com/a/global",
} as NotificationPayload;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("email notification delivery", () => {
  it("fails honestly when unconfigured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await httpTransport.send(channel, payload)).ok).toBe(false);
  });
  it("sends only the recipient-safe message through Resend", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-only");
    vi.stubEnv("AUTH_EMAIL_FROM", "Usurp <notify@example.com>");
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await httpTransport.send(channel, payload)).ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(init.body))).toMatchObject({
      to: ["verified@example.com"],
      text: expect.stringContaining(payload.text),
    });
    expect(init.redirect).toBe("error");
  });
  it("does not leak provider error bodies or credentials", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-only");
    vi.stubEnv("AUTH_EMAIL_FROM", "notify@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sensitive details", { status: 403 })),
    );
    expect(await httpTransport.send(channel, payload)).toEqual({
      ok: false,
      error: "email provider returned HTTP 403",
    });
  });
});
