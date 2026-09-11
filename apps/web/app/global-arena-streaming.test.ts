import { renderToReadableStream } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/session", () => ({ currentUser: async () => undefined }));
vi.mock("../lib/env", () => ({ baseUrl: () => "http://localhost:3000" }));
vi.mock("./hero-stats", () => ({ default: async () => { await new Promise(() => {}); return null; } }));
vi.mock("./feed-view", () => ({ default: async () => { await new Promise(() => {}); return null; } }));
vi.mock("./rating-view", () => ({ default: () => createElement("table", null, createElement("caption", null, "Fresh rating standings")) }));
vi.mock("./board-view", () => ({ default: () => createElement("table", null, createElement("caption", null, "Fresh burn standings")) }));
vi.mock("./board-nav", async (importOriginal) => ({ ...await importOriginal<object>(), default: () => null }));
vi.mock("./live-refresh", () => ({ default: () => null }));
vi.mock("./share-menu", () => ({ default: () => null }));
import Page from "./page";

describe("global arena streaming", () => {
  for (const metric of ["rating", "burn"]) it(`streams ${metric} without waiting for league totals or feed`, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const stream = await renderToReadableStream(await Page({ searchParams: Promise.resolve({ metric }) }), {
      signal: controller.signal, onError: () => {},
    });
    const reader = stream.getReader();
    let html = "";
    try {
      while (!html.includes(`Fresh ${metric} standings`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        html += new TextDecoder().decode(chunk.value);
      }
      expect(html).toContain(`Fresh ${metric} standings`);
      expect(html).toContain("Loading league totals");
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader.cancel();
    }
  });
});
