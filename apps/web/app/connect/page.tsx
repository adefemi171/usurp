import { baseUrl } from "../../lib/env";
import { InstallCommands } from "./install-commands";

export default function ConnectPage() {
  const server = baseUrl();
  const packageUrl = `${server}/downloads/usurp-connect-0.1.0.tgz`;
  return <main className="wrap narrow connect-page">
    <section className="page-intro"><p className="eyebrow">Usurp Connect</p><h1>Your computer.<br/>Connected once.</h1><p>A lightweight local service keeps your coding usage in sync. Set it up in your browser—no app installer, repository cloning, or Docker.</p></section>
    <section className="settings-section"><h2>1. Install and open</h2><p>On the computer where you code, install <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22.13 or newer</a>, then run these commands in your terminal.</p>
      <InstallCommands packageUrl={packageUrl} server={server}/>
      <p className="field-hint">The first command downloads the package from this Usurp deployment; npm then installs that local file. This works even where npm blocks remote package installs. Copy the commands exactly—do not include Markdown brackets or link text. It starts a background process and opens private controls on your computer. macOS and Windows use the OS keychain; Linux needs an unlocked Secret Service keyring.</p>
      <p className="field-hint">macOS installation and syncing are verified. Windows and Linux support is experimental pending platform acceptance tests.</p>
      <p className="field-hint"><a href="/downloads/usurp-connect-0.1.0.tgz" download>Download package</a> · <a href="/downloads/usurp-connect-0.1.0.tgz.sha256">SHA-256 checksum</a></p>
    </section>
    <section className="settings-section"><h2>2. Connect your account</h2><p>In the local controls, choose <strong>Connect account</strong>, follow the approval link, and sign in here. Check that the codes match before approving.</p><p className="field-hint">Your website address is <code>{server}</code>. Registering a device does not upload anything. If you previously used the CLI, stop its sync job before switching to this separately paired service.</p></section>
    <section className="settings-section"><h2>3. Choose sources and start syncing</h2><p>Select your coding tools, optionally include <a href="https://github.com/kenn-io/agentsview" target="_blank" rel="noopener noreferrer">AgentsView ↗</a> or older history, and approve uploading. Choose <strong>Save choices &amp; start syncing</strong>. Wait for a confirmed upload, then open your usage dashboard.</p><p>Only usage summaries leave your computer—not prompts, code, or project names. Costs are estimates or source-calculated, not invoices. Global membership is a separate choice.</p></section>
    <section className="settings-section"><h2>After setup</h2><p>Closing the local browser tab keeps the service running. It checks about every minute while your computer is awake and retries connection failures automatically. Enable <strong>Start when I sign in</strong> in local controls on macOS or Linux; Windows currently needs a manual start after login.</p><p>Run <code>usurp-connect</code> to reopen controls, <code>usurp-connect status</code> to check uploads, or <code>usurp-connect stop</code> to stop. Use <strong>Sync now</strong> in local controls for an immediate upload. The website’s Refresh view only reloads records already received.</p></section>
    <a href="/settings#devices">Back to devices &amp; sync</a>
  </main>;
}
