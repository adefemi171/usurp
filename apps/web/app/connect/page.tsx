import { baseUrl } from "../../lib/env";

function releaseUrl(key: string) {
  const value = process.env[key];
  // Operators enable a platform only after its signed release passes smoke tests.
  return value && /^https:\/\/github\.com\/adefemi171\/usurp\/releases\/download\/[^/]+\/[^/?#]+$/.test(value) ? value : undefined;
}

export default function ConnectPage() {
  const downloads = [
    ["Mac · Apple silicon", releaseUrl("USURP_CONNECT_MAC_ARM64_URL")],
    ["Mac · Intel", releaseUrl("USURP_CONNECT_MAC_X64_URL")],
    ["Windows", releaseUrl("USURP_CONNECT_WINDOWS_URL")],
    ["Linux", releaseUrl("USURP_CONNECT_LINUX_URL")],
  ];
  return <main className="wrap narrow connect-page">
    <section className="page-intro"><p className="eyebrow">Usurp Connect</p><h1>Your coding activity.<br/>Connected.</h1><p>A small companion for the computer where you code. No repository cloning, server, or Docker needed.</p></section>
    <section className="settings-section"><h2>1. Get the companion</h2>
      <div className="connect-options">{downloads.map(([label, url]) => url
        ? <a className="button secondary" key={label} href={url}>{label}</a>
        : <div className="connect-platform" key={label}><strong>{label}</strong><span>Not released yet</span></div>)}</div>
      {!downloads.some(([,url]) => url) && <p className="field-hint">The desktop companion is in testing. Public installers will appear here after signing and release verification. The existing CLI remains available in Settings.</p>}
    </section>
    <section className="settings-section"><h2>2. Open and approve</h2><p>Already installed? Open Usurp Connect, choose <strong>Connect account</strong>, and approve the matching code in your browser.</p><a className="button" href={`usurp-connect://open?server=${encodeURIComponent(baseUrl())}`}>Open Usurp Connect</a><p className="field-hint">If nothing opens, launch the installed app manually. Your website address is <code>{baseUrl()}</code>.</p></section>
    <section className="settings-section"><h2>3. Choose what to sync</h2><p>Select your coding tools and history, then start syncing. Your device key stays in the OS keychain. Only usage summaries leave your computer, not conversations or code.</p><p>AgentsView is optional. Pause syncing at any time, or revoke this computer in Settings. Joining the global board is always a separate choice.</p></section><a href="/settings#devices">Back to devices &amp; sync</a>
  </main>;
}
