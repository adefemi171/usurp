import { afterEach, expect, it, vi } from "vitest";
import { dispatchNotifications, httpTransport, emailNotificationsEnabled } from "./notifications.js";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("does not dispatch any retained external notification in local-only mode", async () => {
  vi.stubEnv("USURP_LOCAL_ONLY", "1");
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  expect(emailNotificationsEnabled()).toBe(false);
  expect(await dispatchNotifications({} as any)).toEqual({considered:0,sent:0,suppressed:0,failed:0});
  expect(await httpTransport.send({kind:"webhook",target:"https://example.com"} as any, {} as any)).toEqual({ok:false,error:"External notifications are disabled in local-only mode"});
  expect(request).not.toHaveBeenCalled();
});
