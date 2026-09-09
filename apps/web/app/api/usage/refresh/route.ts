import { NextResponse } from "next/server";
import { fetchBridgeSnapshot } from "@usurp/protocol";
import { getDb, saveOwnedBridge } from "@usurp/db";
import { requireUser } from "../../../../lib/session";
import { ownedBridge } from "../../../../lib/bridge";

export async function POST(request: Request) {
  const expectedOrigin = new URL(process.env.USURP_BASE_URL ?? "http://localhost:3000").origin;
  if (request.headers.get("origin") !== expectedOrigin) return NextResponse.json({ message: "Cross-origin refresh refused." }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json({ message: "Sign in to refresh your usage source." }, { status: 401 });
  const bridge = await ownedBridge(auth.user.id);
  if (!bridge) return NextResponse.json({ message: "Run usurp sync on your computer to import new usage. This server has no local bridge connection." }, { status: 409 });
  try {
    const snapshot = await fetchBridgeSnapshot(bridge.url);
    if (!await saveOwnedBridge(getDb(), auth.user.id, bridge.deviceId, snapshot)) return NextResponse.json({ message: "Device no longer available." }, { status: 403 });
    return NextResponse.json({ message: "Imported the latest available AgentsView totals. Native readers update when you run usurp sync." });
  } catch {
    return NextResponse.json({ message: "AgentsView could not be imported. Your last successful snapshot is still displayed. Check that AgentsView is running, then retry." }, { status: 502 });
  }
}
