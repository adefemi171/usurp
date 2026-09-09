/**
 * HTTP client for the Usurp API.
 *
 * Errors are values, not exceptions: `usurp sync` runs from a `SessionEnd`
 * hook, where an unhandled rejection means a stack trace in the user's terminal
 * every time their network is flaky. Callers get a discriminated result and
 * decide what is worth printing.
 */

import type { IngestPayload } from "@usurp/protocol";

/** A sync must never hold up the end of someone's coding session for long. */
const TIMEOUT_MS = 15_000;

export interface ApiRejection {
  bucketIndex: number;
  code: string;
  detail: string;
}

export interface IngestOk {
  accepted: number;
  rejected: ApiRejection[];
  flags: ApiRejection[];
}

export interface RegisterOk {
  device_id: string;
  trust_tier: string;
  reused: boolean;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      /** Present on a 409 `stale_seq`, so `sync` can re-anchor its counter. */
      lastSeq?: number;
      issues?: Array<{ path: string; message: string }>;
      rejected?: ApiRejection[];
    };

interface ErrorBody {
  error?: string;
  detail?: string;
  last_seq?: number;
  issues?: Array<{ path: string; message: string }>;
  rejected?: ApiRejection[];
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        error: "network_error",
        detail: `${this.url(path)}: ${reason}`,
      };
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      // A proxy or captive portal returning HTML is common enough to name.
      return {
        ok: false,
        status: response.status,
        error: "invalid_response",
        detail: `expected JSON, got ${text.slice(0, 120)}`,
      };
    }

    if (!response.ok) {
      const body = parsed as ErrorBody;
      return {
        ok: false,
        status: response.status,
        error: body.error ?? `http_${response.status}`,
        detail: body.detail,
        lastSeq: body.last_seq,
        issues: body.issues,
        rejected: body.rejected,
      };
    }

    return { ok: true, data: parsed as T };
  }

  registerDevice(input: {
    code: string;
    publicKey: string;
    label?: string;
  }): Promise<ApiResult<RegisterOk>> {
    return this.post("/v1/devices", {
      code: input.code,
      public_key: input.publicKey,
      ...(input.label ? { label: input.label } : {}),
    });
  }

  ingest(payload: IngestPayload): Promise<ApiResult<IngestOk>> {
    return this.post("/v1/ingest", payload);
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(this.url("/api/health"), {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
