"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** User-controlled updates for a viewed page, never a background keepalive. */
export default function LiveRefresh({ slug = "global" }: { slug?: string }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [restored, setRestored] = useState(false);
  // A client-side metric change preserves this component, and session storage
  // also preserves the explicit choice if a browser has to reload the route.
  useEffect(() => {
    setEnabled(window.sessionStorage.getItem("usurp:auto-refresh") === "on");
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored)
      window.sessionStorage.setItem(
        "usurp:auto-refresh",
        enabled ? "on" : "off",
      );
  }, [enabled, restored]);
  useEffect(() => {
    if (!enabled) return;
    let stream: EventSource | undefined;
    const connect = () => {
      stream?.close();
      stream = undefined;
      if (document.visibilityState !== "visible") return;
      stream = new EventSource(`/v1/arenas/${encodeURIComponent(slug)}/stream`);
      stream.addEventListener("refresh", () => router.refresh());
    };
    connect();
    document.addEventListener("visibilitychange", connect);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => {
      clearInterval(timer);
      stream?.close();
      document.removeEventListener("visibilitychange", connect);
    };
  }, [enabled, router, slug]);
  return (
    <div className="live-control">
      <button
        type="button"
        className="tab"
        aria-pressed={enabled}
        onClick={() => setEnabled(!enabled)}
      >
        {enabled ? "● Auto-refresh on" : "Auto-refresh off"}
      </button>
      <span>
        {enabled
          ? "Live updates while visible, with a one-minute fallback. Rankings update after processing."
          : "Turn on to follow new uploads without reloading."}
      </span>
    </div>
  );
}
