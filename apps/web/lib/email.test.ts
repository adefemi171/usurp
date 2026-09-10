import { afterEach, expect, it, vi } from "vitest";
import { sendSignInCode } from "./email";
afterEach(() => vi.unstubAllEnvs());
it("sends codes only through the configured delivery service", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("AUTH_EMAIL_FROM", "Usurp <signin@example.com>");
  const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  await sendSignInCode("person@example.com", "12345678", request);
  expect(request.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
  expect(JSON.parse(request.mock.calls[0]?.[1].body)).toMatchObject({ to: ["person@example.com"], text: expect.stringContaining("12345678") });
  request.mockResolvedValue(new Response("failure", { status: 500 }));
  await expect(sendSignInCode("person@example.com", "12345678", request)).rejects.toThrow("email_delivery_failed");
});
it("fails closed if delivery is not configured", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const request = vi.fn();
  await expect(sendSignInCode("person@example.com", "12345678", request)).rejects.toThrow("email_not_configured");
  expect(request).not.toHaveBeenCalled();
});
