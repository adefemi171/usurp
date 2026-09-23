"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { getDb, outcomeAttestors } from "@usurp/db";
import { canonicalBytes, verifyBytes } from "@usurp/protocol";
import { currentUser } from "../../lib/session";

const claimSchema = z.object({ purpose: z.literal("usurp-outcome-link-v1"), owner: z.string().uuid(), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export async function linkAttestor(form: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  const raw = String(form.get("proof") ?? "");
  if (raw.length > 1024) throw new Error("Invalid linking proof");
  const { signature, ...claim } = claimSchema.parse(JSON.parse(raw));
  if (claim.owner !== user.id || !verifyBytes(canonicalBytes(claim), signature, claim.publicKey)) throw new Error("Invalid linking proof");
  // First owner is immutable, even if revoked. No takeovers via re-linking.
  await getDb().insert(outcomeAttestors).values({ publicKey: claim.publicKey, userId: user.id }).onConflictDoNothing();
  const [stored] = await getDb().select().from(outcomeAttestors).where(eq(outcomeAttestors.publicKey, claim.publicKey));
  if (!stored || stored.userId !== user.id || stored.revokedAt) throw new Error("Key is already linked or revoked. Use a new attestor key.");
  revalidatePath("/settings"); redirect("/settings#attestors");
}
export async function changeAttestor(form: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  const action = z.enum(["share", "private", "revoke"]).parse(form.get("action"));
  await getDb().update(outcomeAttestors).set(action === "revoke" ? { revokedAt: new Date(), share: false } : { share: action === "share" }).where(and(eq(outcomeAttestors.publicKey, String(form.get("key"))), eq(outcomeAttestors.userId, user.id), isNull(outcomeAttestors.revokedAt)));
  revalidatePath("/settings"); revalidatePath("/outcomes"); redirect("/settings#attestors");
}
