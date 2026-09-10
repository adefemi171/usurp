"use client";

import { useLinkStatus } from "next/link";

/** Feedback without streaming a 200 response before private-route checks. */
export default function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span role="status" className="navigation-pending">
      {" "}
      Loading…
    </span>
  ) : null;
}
