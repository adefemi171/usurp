import { createHash, timingSafeEqual } from "node:crypto";

export function localAuthEnabled(): boolean {
  if (process.env.USURP_LOCAL_ONLY !== "1") return false;
  try {
    const url = new URL(process.env.USURP_BASE_URL ?? "http://localhost:3000");
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      && (process.env.USURP_LOCAL_PASSWORD?.length ?? 0) >= 32;
  } catch { return false; }
}

export function localPasswordMatches(value: string): boolean {
  if (!localAuthEnabled() || value.length > 256) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(value), digest(process.env.USURP_LOCAL_PASSWORD!));
}
