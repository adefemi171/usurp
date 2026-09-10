import { lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Conservative public-unicast check, including IPv4-mapped IPv6 literals. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    // Only global unicast 2000::/3; reject transition, documentation and
    // special-use networks. Mapped IPv4, ULA and link-local never pass here.
    const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const parts = normalized.split(":");
    if (
      parts[0] === "2001" &&
      (parseInt(parts[1] || "0", 16) < 0x200 || parts[1] === "db8")
    )
      return false;
    return /^[23][0-9a-f]{3}:/.test(normalized) && !/^2002:/.test(normalized);
  }
  return false;
}

function allowed(address: string) {
  if (publicAddress(address)) return true;
  if (process.env.NODE_ENV === "production") return false;
  // Explicit local development receivers only. Never allow metadata hosts.
  return (
    address === "::1" ||
    /^(127\.|10\.|192\.168\.)/.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

// Validate the addresses used by the socket itself, not an earlier DNS lookup
// followed by fetch's second resolution (which permits DNS rebinding).
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    if (!addresses.length || addresses.some((a) => !allowed(a.address)))
      return callback(new Error("blocked_destination"), "", 4);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export async function postWebhook(
  target: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  const url = new URL(target),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    ![
      "https:",
      ...(process.env.NODE_ENV !== "production" ? ["http:"] : []),
    ].includes(url.protocol)
  )
    throw Error("invalid_destination");
  if (isIP(host) && !allowed(host)) throw Error("blocked_destination");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers,
        lookup: safeLookup,
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        // We only need the status. Do not buffer a receiver-controlled body and
        // never follow a redirect to a different (possibly private) destination.
        resolve(response.statusCode ?? 500);
        response.destroy();
      },
    );
    request.once("error", () => reject(new Error("webhook_delivery_failed")));
    request.end(body);
  });
}
