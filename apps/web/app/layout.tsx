import type { Metadata } from "next";
import "./globals.css";
import AppNav from "./app-nav";
import { currentUser } from "../lib/session";
import { baseUrl } from "../lib/env";

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl()),
  title: "Usurp — Your AI coding league",
  description:
    "A competitive league for AI coding-agent usage. The Burn board ranks volume, not skill.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#page-content">
          Skip to content
        </a>
        <AppNav handle={user?.handle} />
        <div id="page-content" tabIndex={-1}>
          {children}
        </div>
        <footer className="wrap">
          <p className="field-hint">
            <a href="/privacy">Privacy & data</a> ·{" "}
            <a href="https://github.com/adefemi171/usurp">Open source</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
