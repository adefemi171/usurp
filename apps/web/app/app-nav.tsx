"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import NavigationPending from "./navigation-pending";

export default function AppNav({ handle }: { handle?: string }) {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Overview", active: pathname === "/" || pathname.startsWith("/a/") },
    ...(handle ? [{ href: `/u/${encodeURIComponent(handle)}?window=all`, label: "My usage", active: pathname.startsWith("/u/") }] : []),
    { href: "/halls/longest-reign", label: "Hall of fame", active: pathname.startsWith("/halls/") },
  ];
  return <header className="app-header">
    <div className="app-header-inner">
      <Link href="/" className="app-logo" aria-label="Usurp home">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 9l6 5 5-9 5 9 6-5-3 15H8L5 9Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M10 28h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        usurp<span>.</span><NavigationPending />
      </Link>
      <nav className="app-nav" aria-label="Main navigation">
        {links.map(link => <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined}>{link.label}<NavigationPending /></Link>)}
      </nav>
      <Link className="account-link" href={handle ? "/settings" : "/signin"} aria-current={pathname === "/settings" || pathname === "/signin" ? "page" : undefined}>
        {handle ? <><span className="account-avatar" aria-hidden="true">{handle.slice(0, 1).toUpperCase()}</span><span>Settings</span></> : <>Sign in <span aria-hidden="true">↗</span></>}<NavigationPending />
      </Link>
    </div>
  </header>;
}
