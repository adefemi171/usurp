import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, devices } from "@usurp/db";

/** Admin-controlled local connection; never accept a bridge URL from a browser. */
export async function ownedBridge(userId: string) {
  const url = process.env.USURP_AGENTS_VIEW_URL;
  const deviceId = process.env.USURP_AGENTS_VIEW_DEVICE_ID;
  if (!url || !deviceId) return null;
  const [device] = await getDb().select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)));
  return device ? { url, deviceId } : null;
}
