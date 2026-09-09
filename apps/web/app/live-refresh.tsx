"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** User-controlled updates for a viewed page, never a background keepalive. */
export default function LiveRefresh() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [enabled, router]);
  return <div className="live-control">
    <button type="button" className="tab" aria-pressed={enabled} onClick={() => setEnabled(!enabled)}>{enabled ? "● Auto-refresh on" : "Auto-refresh off"}</button>
    <span>{enabled ? "Every minute while this page is visible. Rankings update after processing." : "Turn on to follow new uploads without reloading."}</span>
  </div>;
}
