"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { BoardWindow, UsageSeriesPoint } from "@usurp/db";
import { agentName, chartDays, colorFor, compact, filterSeries, formatValue, money, number, percentage, sharesFor, summarizeSeries, treemap, sessionOnly, type Grouping, type Metric } from "./dashboard-data";
import { efficiencyAdvice } from "./efficiency-advice";
import styles from "./dashboard.module.css";

const dateLabel = (day: string) => new Date(day).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function Segments<T extends string>({ label, options, value, onChange }: {
  label: string; options: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void;
}) {
  return <div className={styles.segments} role="group" aria-label={label}>
    {options.map(o => <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>;
}

export default function UsageDashboard({ rows, window, flagged, deviceCount, lastSeen, bridgeImports, canRefreshSource, isOwner, feedback = [] }: {
  rows: UsageSeriesPoint[]; window: BoardWindow; flagged: boolean; deviceCount: number; lastSeen: string | null;
  bridgeImports: Array<{ importedAt: string; pricingVersion: string; agents: string[] }>;
  canRefreshSource: boolean; isOwner: boolean;
  feedback?: Array<{ recommendation: string; response: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [metric, setMetric] = useState<Metric>("cost");
  const [refreshing, startRefresh] = useTransition();
  const [refreshMessage, setRefreshMessage] = useState("");
  const refresh = () => startRefresh(async () => {
    setRefreshMessage("");
    if (canRefreshSource) {
      try {
        const response = await fetch("/api/usage/refresh", { method: "POST", signal: AbortSignal.timeout(30_000) });
        const result = await response.json(); setRefreshMessage(result.message);
      } catch { setRefreshMessage("Refresh could not finish. Your saved usage is unchanged. Try again."); }
    } else setRefreshMessage(isOwner ? "Showing saved usage. Run npm run usurp -- sync on your computer to import new activity." : "Showing the latest usage shared by this member.");
    router.refresh();
  });
  const [grouping, setGrouping] = useState<Grouping>("model");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const [view, setView] = useState<"treemap" | "list">("treemap");
  const [feedbackByAdvice, setFeedbackByAdvice] = useState(() => new Map(feedback.map(item => [item.recommendation, item.response])));
  const filtered = filterSeries(rows, agent, model);
  const totals = summarizeSeries(filtered);
  const missingUsage = filtered.some(sessionOnly);
  const onlyMetadata = filtered.length > 0 && filtered.every(sessionOnly);
  const shares = sharesFor(filtered, grouping, metric);
  const days = chartDays(filtered.filter(r => metric === "cost" ? r.costMicros > 0 : !sessionOnly(r)), grouping, metric);
  const hasBridge = filtered.some(r => r.source === "agentsview" || r.source === "mixed");
  const hasNativeCost = filtered.some(r => r.source !== "agentsview" && r.costMicros > 0);
  const missingCalls = filtered.some(r => r.callsAvailable === false);
  const unpricedModels = [...new Set(filtered.filter(r => r.unpricedBuckets > 0).map(r => r.model))];
  const metadataModels = [...new Set(filtered.filter(sessionOnly).map(r => r.model))];
  const tiles = treemap(shares);
  const totalValue = metric === "cost" ? totals.cost : totals.tokens;
  const costUnavailable = onlyMetadata || (totals.unpriced > 0 && !totals.cost);
  const metricUnavailable = metric === "cost" ? costUnavailable : onlyMetadata;
  const peak = days.reduce((best, d) => d.total > (best?.total ?? -1) ? d : best, days[0]);
  const max = Math.max(1, ...days.map(d => d.total)) * 1.1;
  const activeIndex = Math.min(hoverDay ?? Math.max(0, days.length - 1), Math.max(0, days.length - 1));
  const activeDay = days[activeIndex];
  const models = [...new Set(rows.filter(r => !agent || r.agent === agent).map(r => r.model))].sort();
  const agents = [...new Set(rows.map(r => r.agent))].sort();
  const metricLabel = metric === "cost" ? "Usage cost" : "Effective tokens";
  const groupLabel = (name: string) => grouping === "agent" ? agentName(name) : name;
  const chooseGroup = (name: string) => {
    if (grouping === "agent") { setAgent(agent === name ? "" : name); setModel(""); }
    else setModel(model === name ? "" : name);
    setHoverDay(null);
  };
  const reset = () => { setAgent(""); setModel(""); setHoverDay(null); };
  const x = (i: number) => days.length > 1 ? i / (days.length - 1) * 1000 : 500;
  const y = (value: number) => 220 - value / max * 220;
  const stacked = Array.from({ length: days.length }, () => 0);
  const areas = shares.map(share => {
    const bottom = [...stacked];
    days.forEach((d, i) => { stacked[i] = (stacked[i] ?? 0) + (d.values[share.name] ?? 0); });
    const top = [...stacked];
    const points = days.length === 1
      ? `0,${y(top[0]!)} 1000,${y(top[0]!)} 1000,${y(bottom[0]!)} 0,${y(bottom[0]!)}`
      : [...top.map((v, i) => `${x(i)},${y(v)}`), ...bottom.map((v, i) => `${x(i)},${y(v)}`).reverse()].join(" ");
    return { name: share.name, points };
  });
  const topPairs = new Map<string, { agent: string; model: string; value: number; calls: number; unpriced: number; sessions: number }>();
  for (const row of filtered) {
    if (sessionOnly(row)) continue;
    const key = JSON.stringify([row.agent, row.model]);
    const pair = topPairs.get(key) ?? { agent: row.agent, model: row.model, value: 0, calls: 0, unpriced: 0, sessions: 0 };
    pair.sessions += row.sessionsStarted;
    pair.value += metric === "cost" ? row.costMicros : row.effectiveTokens;
    pair.calls += row.calls; pair.unpriced += row.unpricedBuckets; topPairs.set(key, pair);
  }
  const ranked = [...topPairs.values()].sort((a, b) => b.value - a.value || b.calls - a.calls || b.sessions - a.sessions);
  const cache = [{ label: "Cache reads", value: totals.cacheRead, color: "#50bfad" },
    { label: "Cache writes", value: totals.cacheWrite, color: "#8f9cf7" },
    { label: "Reported input", value: totals.input, color: "#d8a657" },
    { label: "Output", value: totals.output, color: "#65a5f5" }];
  const cacheMax = Math.max(1, ...cache.map(c => c.value));
  // Coaching is personal. Public profiles remain aggregate-usage views and do
  // not reveal a member's optimization opportunities to other visitors.
  const advice = isOwner ? efficiencyAdvice(filtered).sort((a, b) => Number(feedbackByAdvice.get(b.id) === "useful") - Number(feedbackByAdvice.get(a.id) === "useful")) : [];
  const rateAdvice = async (recommendation: string, response: "useful" | "dismissed") => {
    setFeedbackByAdvice(current => new Map(current).set(recommendation, response));
    try { await fetch("/v1/me/efficiency-feedback", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendation, response }) }); } catch { /* Local state keeps the choice for this visit. */ }
  };
  const cards = [
    { label: "Usage cost", value: costUnavailable ? "Unavailable" : money(totals.cost), hint: costUnavailable ? "No priced usage recorded" : hasBridge ? (hasNativeCost ? "AgentsView + native estimates" : "AgentsView · historical API rates") : "Native estimate · not a bill", highlight: metric === "cost" },
    { label: "Effective tokens", value: onlyMetadata ? "Unavailable" : compact(totals.tokens), hint: "Input + output + cache write", highlight: metric === "tokens" },
    { label: "Cache reads", value: onlyMetadata ? "Unavailable" : compact(totals.cacheRead), hint: "Excluded from effective tokens" },
    { label: "Models with usage", value: number(totals.models), hint: `${metadataModels.length} with selected-model metadata only` },
    { label: "Active days", value: number(totals.activeDays), hint: "With recorded calls or tokens" },
    { label: "Peak day", value: peak && totalValue > 0 ? formatValue(peak.total, metric) : "—", hint: metricUnavailable ? "Usage not available for this metric" : peak && totalValue > 0 ? `${dateLabel(peak.day)} · UTC` : "No measured activity" },
  ];
  return <>
    <div className={styles.toolbar}>
      <Segments label="Usage metric" value={metric} onChange={setMetric} options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} />
      <label className={styles.filter}>Period<select aria-label="Time period" value={window} onChange={e => router.push(`${pathname}?window=${e.target.value}`)}>
        <option value="day">Today (UTC)</option><option value="week">Last 7 UTC days</option><option value="month">Last 30 UTC days</option><option value="all">All time</option>
      </select></label>
      <label className={styles.filter}>Agent<select aria-label="Agent filter" value={agent} onChange={e => { setAgent(e.target.value); setModel(""); setHoverDay(null); }}>
        <option value="">All agents</option>{agents.map(a => <option key={a} value={a}>{agentName(a)}</option>)}
      </select></label>
      <label className={`${styles.filter} ${styles.modelFilter}`}>Model<select aria-label="Model filter" value={model} onChange={e => { setModel(e.target.value); setHoverDay(null); }}>
        <option value="">All models</option>{models.map(m => <option key={m}>{m}</option>)}
      </select></label>
      {(agent || model) && <button className={styles.reset} onClick={reset}>Reset filters</button>}
      <button className={styles.refresh} disabled={refreshing} onClick={refresh} aria-label="Refresh usage">↻ <span>{refreshing ? "Refreshing…" : canRefreshSource ? "Refresh source" : "Refresh view"}</span></button>
    </div>
    <div className={styles.sourceBar}>
      <span className={styles.sourceBadge}>{hasBridge ? <a href="https://github.com/kenn-io/agentsview" target="_blank" rel="noopener noreferrer">AgentsView snapshot ↗</a> : "Native readers"}</span>
      <span>{bridgeImports.length ? `Last bridge import: ${bridgeImports.map(s => s.importedAt).sort()[0]!.slice(0, 16).replace("T", " ")} UTC` : "No bridge snapshot imported"}</span>
      <span>{deviceCount} device{deviceCount === 1 ? "" : "s"} · USD · UTC days</span>
    </div>
    {refreshMessage && <p className={styles.refreshStatus} role="status">{refreshMessage}</p>}
    <div className={styles.cards} aria-label="Usage summary">{cards.map(c => <article className={`${styles.card} ${c.highlight ? styles.highlight : ""}`} key={c.label}>
      <p>{c.label}</p><strong>{c.value}</strong><small>{c.hint}</small>
    </article>)}</div>
    {!!advice.length && <details className={styles.advice} aria-label="Efficiency coach">
      <summary><span>Efficiency coach</span><small>{advice.length} suggestion{advice.length === 1 ? "" : "s"} · Show</small></summary>
      <div className={styles.adviceContent}>
        <div className={styles.panelHeader}><div><h2>Efficiency coach</h2><p>Suggestions from aggregate usage only — never your prompts, code, projects, or commands.</p></div><a href="/connect#local-coaching" className={styles.adviceLink}>Set up local coaching ↗</a></div>
        <div className={styles.adviceGrid}>{advice.map(item => <article key={item.id}>
          <h3>{item.title}</h3><p>{item.detail}</p><strong>Try this:</strong><p>{item.action}</p>
          <div className={styles.adviceActions}><button type="button" aria-pressed={feedbackByAdvice.get(item.id) === "useful"} onClick={() => rateAdvice(item.id, "useful")}>Useful</button><button type="button" aria-pressed={feedbackByAdvice.get(item.id) === "dismissed"} onClick={() => rateAdvice(item.id, "dismissed")}>Not for me</button></div>
          {item.id === "local" && <a className={styles.runewardLink} href="https://runewardd.github.io/runeward/" target="_blank" rel="noopener noreferrer">Learn about Runeward governance ↗</a>}
        </article>)}</div>
      </div>
    </details>}
    <details className={styles.coverage}>
      <summary><span>{totals.unpriced || missingUsage ? "Partial data coverage" : "Data sources & coverage"}</span><span>{onlyMetadata || !filtered.length ? "No measured usage" : unpricedModels.length ? `${unpricedModels.length} unpriced model${unpricedModels.length === 1 ? "" : "s"}` : "All measured usage priced"}{metadataModels.length ? ` · ${metadataModels.length} metadata-only model${metadataModels.length === 1 ? "" : "s"}` : ""} <span aria-hidden="true">↗</span></span></summary>
      <div className={styles.coverageBody}>
        <p>Usage cost is an API-rate calculation, not the amount charged to your account. <a href="https://github.com/kenn-io/agentsview" target="_blank" rel="noopener noreferrer">AgentsView ↗</a> totals are imported unchanged; native estimates are used only for tools outside the snapshot. No usage is counted twice.</p>
        {!!unpricedModels.length && <p><strong>Price unavailable:</strong> {unpricedModels.join(", ")}. Recorded tokens remain visible; unknown prices are not treated as free usage.</p>}
        {missingUsage && <p><strong>Selected model only:</strong> {metadataModels.join(", ")}. These saved conversations have no measured tokens. Cursor’s current model selection does not identify every model used in a conversation. To add measured model usage, import a Cursor usage CSV with token counters.</p>}
        {hasBridge && <p>Bridge snapshots have daily tokens and cost, but no call, session, edit, or commit counts. Those fields are shown as unavailable, never invented. AgentsView must have collected new activity before Refresh source can import it.</p>}
        {flagged && <p>Native records also have validation flags. They remain attached to the original hourly records; importing a bridge snapshot does not change competitive scoring.</p>}
        {totals.historical > 0 && <p>{totals.historical} historical native buckets are analytics-only, without rating, streak, or duel credit.</p>}
        {bridgeImports.map((s, i) => <p key={i}>AgentsView: {s.agents.map(agentName).join(", ")} · pricing version {s.pricingVersion}.</p>)}
      </div>
    </details>
    {!filtered.length ? <section className={styles.empty}><span>◌</span><h2>No activity in this view</h2><p>Try All time or reset the model and agent filters.</p><button className={styles.linkButton} onClick={reset}>Reset filters</button></section> : <>
      <section className={styles.panel} aria-label="Usage over time">
        <div className={styles.panelHeader}><div><h2>{metricLabel} over time</h2><p>Daily activity · UTC{metric === "cost" && totals.unpriced ? " · Priced records only" : ""}</p></div>
          <Segments label="Chart grouping" value={grouping} onChange={setGrouping} options={[{ value: "model", label: "Model" }, { value: "agent", label: "Agent" }]} />
        </div>
        {totalValue > 0 ? <>
          <div className={styles.chartReadout} aria-live="polite"><span>{activeDay?.day}</span><strong>{formatValue(activeDay?.total ?? 0, metric)}</strong>
            <span>{activeDay && shares.filter(s => (activeDay.values[s.name] ?? 0) > 0).map(s => `${groupLabel(s.name)}: ${formatValue(activeDay.values[s.name]!, metric)}`).join(" · ") || "No measured usage on this day"}</span></div>
          <div className={styles.chart}>
            <div className={styles.yAxis}>{[1, .75, .5, .25, 0].map(v => <span key={v}>{formatValue(max * v, metric)}</span>)}</div>
            <div className={styles.plot}>
              <svg viewBox="0 0 1000 220" preserveAspectRatio="none" role="img" aria-label={`${metricLabel} stacked by ${grouping}, ${days[0]?.day} to ${days.at(-1)?.day}`}
                onPointerMove={e => { const rect = e.currentTarget.getBoundingClientRect(); setHoverDay(Math.max(0, Math.min(days.length - 1, Math.round((e.clientX - rect.left) / rect.width * (days.length - 1))))); }}>
                {[0, 55, 110, 165, 220].map(v => <line key={v} x1="0" y1={v} x2="1000" y2={v} className={styles.gridLine} />)}
                {areas.map(a => <polygon key={a.name} points={a.points} fill={colorFor(a.name)} fillOpacity="0.84"><title>{groupLabel(a.name)}</title></polygon>)}
                <line x1={x(activeIndex)} x2={x(activeIndex)} y1="0" y2="220" className={styles.crosshair} />
              </svg>
              <div className={styles.xAxis}>{[...new Set([0, Math.floor((days.length - 1) / 4), Math.floor((days.length - 1) / 2), Math.floor((days.length - 1) * .75), days.length - 1])].map(i => <span key={i}>{dateLabel(days[i]!.day)}</span>)}</div>
            </div>
          </div>
          <label className={styles.scrubber}>Inspect day<input aria-label="Inspect chart day" aria-valuetext={activeDay?.day} type="range" min="0" max={Math.max(0, days.length - 1)} value={activeIndex} onChange={e => setHoverDay(Number(e.target.value))} /></label>
          <div className={styles.legend}>{shares.map(s => <button key={s.name} onClick={() => chooseGroup(s.name)} title={`Filter to ${groupLabel(s.name)}`}><i style={{ background: colorFor(s.name) }} />{groupLabel(s.name)}</button>)}</div>
        </> : <div className={styles.chartEmpty}>{onlyMetadata ? "This selection contains saved conversations, but no measured tokens or cost." : metric === "cost" ? "No priced usage in this selection. Switch to Tokens to see recorded activity." : "These records contain session activity, but no measured tokens."}</div>}
      </section>
      <section className={styles.panel} aria-label="Usage attribution">
        <div className={styles.panelHeader}><div><h2>{metric === "cost" ? "Cost" : "Token"} attribution</h2><p>By {grouping} · click a tile or legend to filter</p></div>
          <Segments label="Attribution view" value={view} onChange={setView} options={[{ value: "treemap", label: "Treemap" }, { value: "list", label: "List" }]} />
        </div>
        {shares.length ? <div className={view === "treemap" ? styles.attribution : styles.listOnly}>
          {view === "treemap" && <div className={styles.treemap}>{tiles.map(tile => <button key={tile.name} className={styles.treeTile}
            style={{ left: `${tile.x}%`, top: `${tile.y}%`, width: `${tile.width}%`, height: `${tile.height}%`, background: colorFor(tile.name) }}
            onClick={() => chooseGroup(tile.name)} aria-label={`Filter to ${groupLabel(tile.name)}: ${formatValue(tile.value, metric)}`}
            title={`${groupLabel(tile.name)} · ${formatValue(tile.value, metric)} · ${percentage(tile.value, totalValue)}`}>
            {tile.width > 12 && tile.height > 13 && <><strong>{groupLabel(tile.name)}</strong><span>{formatValue(tile.value, metric)}</span><small>{percentage(tile.value, totalValue)}</small></>}
          </button>)}</div>}
          <div className={styles.shareList}>{shares.map((s, i) => <button key={s.name} onClick={() => chooseGroup(s.name)}>
            <span className={styles.rank}>{i + 1}</span><i style={{ background: colorFor(s.name) }} /><span>{groupLabel(s.name)}</span><strong>{formatValue(s.value, metric)}</strong><small>{percentage(s.value, totalValue)}</small>
          </button>)}</div>
        </div> : <p className={styles.chartEmpty}>No {metric === "cost" ? "priced usage" : "measured tokens"} to attribute.</p>}
      </section>
      <div className={styles.bottomGrid}>
        <section className={styles.panel} aria-label="Top models"><div className={styles.panelHeader}><div><h2>Top models by {metric === "cost" ? "usage cost" : "tokens"}</h2><p>Measured usage across your coding tools</p></div><span className={styles.count}>{ranked.length}</span></div>
          <div className={styles.ranking}>{!ranked.length && <p className={styles.chartEmpty}>No measured model usage. Session-only records are available in the exact data below.</p>}{ranked.map((r, i) => <div className={styles.rankRow} key={`${r.agent}:${r.model}`}>
            <span className={styles.rank}>{i + 1}</span><div><strong>{r.model}</strong><span>{agentName(r.agent)} · {r.calls ? `${number(r.calls)} native calls` : "Daily usage snapshot"}</span><div className={styles.miniTrack}><i style={{ width: `${ranked[0]?.value ? r.value / ranked[0].value * 100 : 0}%`, background: colorFor(r.model) }} /></div></div>
            <span className={styles.rankValue}>{metric === "cost" && r.unpriced && r.value === 0 ? "Unpriced" : !r.calls && !r.value ? "Usage unavailable" : formatValue(r.value, metric)}</span>
          </div>)}</div>
        </section>
        <section className={styles.panel} aria-label="Token composition"><div className={styles.panelHeader}><div><h2>Cache & token composition</h2><p>Recorded counters · no inferred savings</p></div></div>
          {onlyMetadata ? <p className={styles.chartEmpty}>Token counters are unavailable for these saved conversations.</p> : <div className={styles.cacheBars}>{cache.map(c => <div key={c.label}><span>{c.label}</span><div className={styles.barTrack}><i style={{ width: `${c.value / cacheMax * 100}%`, background: c.color }} /></div><strong title={number(c.value)}>{compact(c.value)}</strong></div>)}</div>}
          <p className={styles.cacheNote}>Cache reads are shown separately and do not count toward effective tokens. Some readers do not report cache accounting.</p>
          <div className={styles.cacheFooter}><span>AVERAGE / ACTIVE DAY</span><strong>{metricUnavailable ? "Unavailable" : totals.activeDays ? formatValue(totalValue / totals.activeDays, metric) : "—"}</strong></div>
        </section>
      </div>
      <details className={`${styles.panel} ${styles.exact}`}><summary>View exact daily data <span>{filtered.length} daily model / agent records</span></summary><div className={styles.tableScroll}>
        <table><caption>Reported counters for the selected filters. Unavailable means the source did not supply this field.</caption><thead><tr>{["Day (UTC)", "Agent", "Model", "Source", "Calls", "Input", "Output", "Cache write", "Cache read", "Usage cost (USD)", "Sessions started", "Completed", "Abandoned", "Edits applied", "Reverted", "Commits"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{[...filtered].reverse().map(r => <tr key={JSON.stringify([r.day, r.agent, r.model])}>
            <td>{r.day}{r.historicalBuckets > 0 ? " · historical" : ""}</td><td>{agentName(r.agent)}</td><td>{r.model}</td><td>{r.source ?? "native"}</td>
            <td>{sessionOnly(r) || r.callsAvailable === false ? "Unavailable" : number(r.calls)}</td>
            {[r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens].map((n, i) => <td key={i}>{sessionOnly(r) ? "Unavailable" : number(n)}</td>)}
            <td>{sessionOnly(r) ? "Unavailable" : r.unpricedBuckets ? (r.costMicros ? `${(r.costMicros / 1_000_000).toFixed(6)} (partial)` : "Unpriced") : (r.costMicros / 1_000_000).toFixed(6)}</td>
            {[r.sessionsStarted, r.sessionsCompleted, r.sessionsAbandoned, r.editsApplied, r.editsReverted, r.commits].map((n, i) => <td key={i}>{r.callsAvailable === false ? "Unavailable" : number(n)}</td>)}
          </tr>)}</tbody></table>
      </div></details>
    </>}
    <p className={styles.lastSeen}>{lastSeen ? `Latest native activity: ${lastSeen.slice(0, 16).replace("T", " ")} UTC` : "No native activity yet"} · {onlyMetadata ? "Call counts unavailable." : missingCalls ? "Call counts are incomplete in this view." : `${number(totals.calls)} native calls.`} Refresh never reads files from your computer.</p>
  </>;
}
