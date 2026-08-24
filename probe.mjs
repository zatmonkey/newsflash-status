// Newsflash status probe. Runs from GitHub Actions cron (independent of the
// Fly infra it watches). Probes each component, maintains history.json
// (raw last 48h + daily aggregates 90d), auto-opens/closes incidents, and
// restarts the Fly machines after 3 consecutive API failures (30min cooldown).
// No dependencies — Node 20+ built-ins only.
import { readFileSync, writeFileSync } from "node:fs";

const COMPONENTS = {
  website: { url: "https://newsflash.sh/", method: "GET", ok: (res) => res.status === 200 },
  api: {
    url: "https://newsflash.sh/api/health",
    method: "GET",
    // Health alone is not enough: the crawler froze for a WEEK (2026-08-17→24)
    // while every endpoint answered 200. A healthy news service must also have
    // FRESH data — the newest article may never be older than 2 hours (the
    // crawler runs every 10 minutes; feeds are never all quiet for 2h).
    ok: async (res) => {
      if (res.status !== 200) return false;
      const body = await res.json();
      if (body.ok !== true) return false;
      const ageMs = Date.now() - Date.parse(body.latest);
      return Number.isFinite(ageMs) && ageMs < 2 * 3600_000;
    },
  },
  mcp: {
    url: "https://newsflash.sh/mcp",
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ok: (res) => res.status === 200 || res.status === 202,
  },
};

const FAILURES_BEFORE_RESTART = 3;
const RESTART_COOLDOWN_MS = 30 * 60_000;
const RAW_WINDOW_MS = 48 * 3600_000;
const DAILY_WINDOW_DAYS = 90;

const now = Date.now();
const iso = (t) => new Date(t).toISOString();

function load(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
const history = load("history.json", { raw: [], daily: {}, state: {} });
const incidents = load("incidents.json", []);

// ---- probe all components (2 attempts each — transient network blips on the
// runner must not page anyone) ----
async function probe(name, def) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(def.url, {
        method: def.method,
        headers: def.headers,
        body: def.body,
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      const ok = await def.ok(res);
      if (ok) return { ok: true, ms: Date.now() - started };
      if (attempt === 1) return { ok: false, ms: Date.now() - started, detail: `status ${res.status}` };
    } catch (e) {
      if (attempt === 1) return { ok: false, ms: Date.now() - started, detail: e.name === "TimeoutError" ? "timeout" : e.message?.slice(0, 80) };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const results = {};
for (const [name, def] of Object.entries(COMPONENTS)) results[name] = await probe(name, def);
console.log(iso(now), JSON.stringify(results));

// ---- history: raw entry + daily aggregate ----
history.raw.push({ t: now, ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [v.ok ? 1 : 0, v.ms]])) });
history.raw = history.raw.filter((e) => now - e.t < RAW_WINDOW_MS);

const day = iso(now).slice(0, 10);
history.daily[day] ??= {};
for (const [name, r] of Object.entries(results)) {
  const d = (history.daily[day][name] ??= { probes: 0, fails: 0, ms: 0 });
  d.probes += 1;
  if (!r.ok) d.fails += 1;
  d.ms = Math.round(d.ms + (r.ms - d.ms) / d.probes); // running mean
}
for (const key of Object.keys(history.daily)) {
  if ((now - Date.parse(key)) / 86400_000 > DAILY_WINDOW_DAYS) delete history.daily[key];
}

// ---- incident bookkeeping ----
const state = history.state;
for (const [name, r] of Object.entries(results)) {
  const s = (state[name] ??= { consecutiveFails: 0 });
  if (r.ok) {
    if (s.openIncident != null) {
      const inc = incidents.find((i) => i.id === s.openIncident);
      if (inc && !inc.resolved) {
        inc.resolved = iso(now);
        console.log(`incident resolved: ${inc.id}`);
      }
      s.openIncident = null;
    }
    s.consecutiveFails = 0;
  } else {
    s.consecutiveFails += 1;
    if (s.consecutiveFails === FAILURES_BEFORE_RESTART && s.openIncident == null) {
      const id = `${day}-${name}`;
      if (!incidents.some((i) => i.id === id && !i.resolved)) {
        incidents.unshift({
          id,
          component: name,
          started: iso(now - (FAILURES_BEFORE_RESTART - 1) * 5 * 60_000),
          resolved: null,
          title: `${name} unreachable (${r.detail ?? "no response"})`,
          body: "Auto-detected by the status probe. Investigation pending.",
          auto: true,
        });
        console.log(`incident opened: ${id}`);
      }
      s.openIncident = id;
    }
  }
}

// ---- self-healing: restart Fly machines on sustained API failure ----
const flyToken = process.env.FLY_API_TOKEN;
const apiState = state.api ?? { consecutiveFails: 0 };
const restartDue =
  apiState.consecutiveFails >= FAILURES_BEFORE_RESTART &&
  (!state.lastRestart || now - state.lastRestart > RESTART_COOLDOWN_MS);
if (restartDue && flyToken) {
  try {
    const machines = await (
      await fetch("https://api.machines.dev/v1/apps/newsflash-sh/machines", {
        headers: { Authorization: `Bearer ${flyToken}` },
        signal: AbortSignal.timeout(15_000),
      })
    ).json();
    for (const m of machines.filter((m) => m.state === "started")) {
      const res = await fetch(`https://api.machines.dev/v1/apps/newsflash-sh/machines/${m.id}/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${flyToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`restarted machine ${m.id}: ${res.status}`);
    }
    state.lastRestart = now;
    const inc = incidents.find((i) => i.id === apiState.openIncident);
    if (inc) inc.body += ` Auto-restart triggered at ${iso(now)}.`;
  } catch (e) {
    console.log("restart failed:", e.message);
  }
}

writeFileSync("history.json", JSON.stringify(history));
writeFileSync("incidents.json", JSON.stringify(incidents, null, 2) + "\n");

// Signal overall state to the workflow (creates a GitHub issue on new outage).
const failing = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
if (failing.length) {
  writeFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `failing=${failing.join(",")}\nconsecutive=${apiState.consecutiveFails}\n`, { flag: "a" });
}
