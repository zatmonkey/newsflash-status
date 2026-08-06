# newsflash-status

Public status page + uptime probe for [newsflash.sh](https://newsflash.sh),
deliberately hosted on infrastructure independent of the service it watches
(GitHub Pages + Actions; the service runs on Fly.io).

**Status page: [status.newsflash.sh](https://status.newsflash.sh)**

## How it works

- `probe.mjs` runs on a 5-minute Actions cron and checks three components from
  the outside: the website, the REST API (`/api/health`), and the MCP endpoint
  (`/mcp` ping). Two attempts per component so runner blips don't page anyone.
- Results land in `history.json` (raw last 48 h + daily aggregates for 90 days,
  committed by the workflow). `index.html` renders it — no build step.
- Incidents open automatically after 3 consecutive failures and resolve
  automatically on recovery. Postmortem text is edited into `incidents.json`
  by a human (or an agent) afterwards.
- **Self-healing:** 3 consecutive API failures trigger a Fly machine restart
  via the Machines API (app-scoped token, 30-minute cooldown), and an issue is
  opened in this repo as the alert channel.

## Postmortems

### 2026-08-06 — feed-crawler memory leak (root cause of both August outages)

rss-parser's `parseURL` rejects on timeout without destroying the underlying
request. With ~45 dead feeds among the 265 crawled every 10 minutes, each cycle
stranded ~46 live sockets pinning their response buffers: ~16 MB of
unreclaimable heap per cycle, OOM-kill every ~18 h. On 08-05 the restarted
process came back wedged, taking the site down for most of the day until a
manual restart. Fixed by fetching feeds with `fetch` + `AbortSignal.timeout`
(real connection teardown), an 8 MB response cap, and a fresh parser per feed.
Verified flat at +0.2 MB/cycle. Swap was also enabled and this probe's
auto-restart added so the failure mode can't strand the service again.
