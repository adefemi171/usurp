const TOOL_NAMES: Record<string, string> = {
  codex: "Codex", cursor: "Cursor", "claude-code": "Claude Code",
  claude: "Claude", "vscode-copilot": "VS Code Copilot", copilot: "Copilot",
  qwen: "Qwen", antigravity: "Antigravity", gemini: "Gemini", opencode: "OpenCode",
};

export function StreakBadge({ days }: { days: number }) {
  if (days <= 0) return <span className="sub" aria-label="No current streak">—</span>;
  return <span className="streak-badge" title="Consecutive UTC days with qualifying signed usage. Includes a streak ending yesterday while today is still in progress.">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M13 3c1 5-5 6-4 10 1-1 2-2 2-3 4 3 6 5 5 8-1 3-7 4-10 0-4-6 2-10 7-15Z" />
    </svg>
    {days} {days === 1 ? "day" : "days"}
  </span>;
}

export function ToolBadges({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return <div className="arena-tools" aria-label="Shared coding tools, last 30 days">
    {tools.slice(0, 2).map(tool => <span className="arena-tool" key={tool}>
      {TOOL_NAMES[tool] ?? tool}
    </span>)}
    {tools.length > 2 && <details className="arena-tools-more">
      <summary aria-label={`Show ${tools.length - 2} more coding tools`}>+{tools.length - 2}</summary>
      <span>{tools.slice(2).map(tool => <span className="arena-tool" key={tool}>{TOOL_NAMES[tool] ?? tool}</span>)}</span>
    </details>}
  </div>;
}
