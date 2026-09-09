"use client";

/**
 * Platform share controls for a public arena card.
 *
 * X, LinkedIn and Facebook expose web share endpoints. Instagram and TikTok
 * do not offer a browser compose URL, so those actions copy the public card
 * URL first and then open the selected network for the user to paste it.
 */

import { useState } from "react";

export default function ShareMenu({ url, text }: { url: string; text: string }) {
  const [status, setStatus] = useState("");
  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(text);

  async function copyAndOpen(platform: "Instagram" | "TikTok", destination: string) {
    try {
      await navigator.clipboard.writeText(url);
      setStatus(`Link copied. Paste it into your ${platform} post.`);
    } catch {
      setStatus(`Copy this link into your ${platform} post: ${url}`);
    }
    window.open(destination, "_blank", "noopener,noreferrer");
  }

  return (
    <details className="share-menu">
      <summary className="tab small">Share the Throne</summary>
      <div className="share-popover">
        <a href={`https://x.com/intent/post?text=${encodedText}&url=${encodedUrl}`} target="_blank" rel="noreferrer">
          X
        </a>
        <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`} target="_blank" rel="noreferrer">
          LinkedIn
        </a>
        <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`} target="_blank" rel="noreferrer">
          Facebook
        </a>
        <button type="button" onClick={() => void copyAndOpen("Instagram", "https://www.instagram.com/")}>
          Instagram
        </button>
        <button type="button" onClick={() => void copyAndOpen("TikTok", "https://www.tiktok.com/")}>
          TikTok
        </button>
        {status && <p role="status">{status}</p>}
      </div>
    </details>
  );
}
