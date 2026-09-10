import { emailAuthEnabled } from "./env";

export async function sendSignInCode(to: string, code: string, request: typeof fetch = fetch): Promise<void> {
  if (!emailAuthEnabled()) throw new Error("email_not_configured");
  const response = await request("https://api.resend.com/emails", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM, to: [to], subject: "Your Usurp sign-in code",
      text: `Your Usurp verification code is ${code}.\n\nEnter it in the browser where you requested it. It expires in 10 minutes and can be used once. Never share this code. If you did not request it, ignore this email.` }),
  });
  // Never log provider bodies: they may contain the code or recipient.
  if (!response.ok) throw new Error("email_delivery_failed");
}
