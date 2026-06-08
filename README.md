# Vintech Inventory Web Tool

A small web app that reproduces the Power Query "weekly inventory" report as an
interactive page, with two views:

1. **Part detail** (`index.html`) — pick a **part number** and a **week range** and
   get a **combo chart** (received / depleted bars + valuation line) plus a data
   table. Export to CSV or PNG.
2. **Purchasing variability** (`variability.html`) — a catalog-wide scatter, one
   dot per material: x = variability (CV) of weekly depletion, y = CV of weekly
   receipts, with a y = x reference line, bubble size = inventory $. Dots above
   the line are materials whose receipts are lumpier than the demand driving them
   — the "is purchasing the problem?" suspects, ranked in one glance.

Both pull live from Plex.

## How it works

```
Browser (public/)  ──>  Node/Express server (server.js)  ──>  Plex datasource API
   part no + weeks          loops the weeks, sums columns        18777/execute
   Chart.js combo chart     (same logic as the M query)
```

The server holds the Plex credential, so it is **never exposed to the browser**,
and it sidesteps CORS (the browser can't call Plex directly).

### Performance & caching

The part-detail view is a handful of Plex calls and returns in seconds. The
**variability** view is heavy — one call per material per week (~290 calls for
29 materials × 10 weeks) — and some material queries are slow, so:

- It runs as a **background job** the page polls, showing a **progress bar**
  instead of freezing (and avoiding any proxy/HTTP timeout when deployed).
- Results are **cached on disk** (`.cache/weeks.json`). A finished week never
  changes, so it's cached permanently; the in-progress week is cached for 1 hour.
  **The first run warms the cache (~5 min); after that, runs are near-instant**
  (a fresh pull each hour to refresh the current week, then instant within the
  hour). Any weeks that time out simply retry on the next run.

To pre-warm the cache (so the first user doesn't wait), just hit the variability
page once after starting the server, or call:

```powershell
curl.exe -X POST "http://localhost:3000/api/variability/start?weeks=52"
```

Relevant `.env` knobs: `VARIABILITY_CONCURRENCY` (default 5), `PLEX_TIMEOUT_MS`
(per-call timeout, default 30000), `CURRENT_WEEK_TTL_MS` (in-progress week cache,
default 3600000).

## Run locally

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder, install dependencies:

   ```powershell
   npm install
   ```

3. Confirm `.env` has your Plex token (already filled in from your Power Query).
   To rotate it, edit `PLEX_AUTH` — it's the Base64 string after `Basic ` in the
   query's Authorization header.

4. Start it:

   ```powershell
   npm start
   ```

5. Open <http://localhost:3000>.

## Using it

- **Part No.** — supports the Plex `%` wildcard, e.g. `65-%`.
- **Week range** — past 10 / 13 / 20 / 26 / 52 weeks (Sunday-anchored, same as the
  report).
- **Valuation line** — choose which series draws on the right axis (cost or qty).

The chart:

- Green bars = **Received** (Qty_Recv + Qty_Add + Qty_Subcon_Recv)
- Red bars (downward) = **Depleted** (Qty_BOM + Qty_Scrap + Qty_Ship + Qty_Subcon_Ship)
- Dashed grey line = **Net change** (received − depleted)
- Blue line (right axis) = **inventory valuation**

## Deploy

Any host that runs Node works (internal IIS/Node, a small VM, Azure App Service,
Render, Railway, etc.). Set the same environment variables (`PLEX_AUTH`, etc.) in
the host's config instead of shipping `.env`. For a company-internal tool, put it
behind your existing SSO / VPN / reverse proxy.

> **Never deploy the `.env` file.** The credential belongs in the host's
> environment settings, not in the uploaded files. The server refuses to start if
> `PLEX_AUTH` is missing, so a misconfigured deploy fails loudly instead of
> serving errors.

### Azure App Service (Node)

1. **Create** a Linux App Service with the Node 18+ (or 20 LTS) runtime.

2. **Set Application Settings** (Portal → your App Service → *Settings →
   Environment variables → App settings*). These become real environment
   variables — no `.env` file is needed or wanted:

   | Name | Value |
   | --- | --- |
   | `PLEX_AUTH` | `<the Base64 token after "Basic " in your Power Query header>` |
   | `PLEX_HOST` | `https://Vintech.on.plex.com` |
   | `PLEX_DATASOURCE_ID` | `18777` |
   | `COMPANY_UTC_OFFSET` | `-5` |

   You do **not** need to set `PORT` — Azure provides it and the app already reads
   `process.env.PORT`. Optional tuning knobs (`VARIABILITY_CONCURRENCY`,
   `PLEX_TIMEOUT_MS`, `CURRENT_WEEK_TTL_MS`) can be added the same way if needed.

3. **Deploy the code** (VS Code Azure extension, `az webapp up`, GitHub Actions,
   or zip deploy). Make sure `.env` and `node_modules/` are **excluded** (the
   `.gitignore` already handles git-based deploys; for zip deploys, don't include
   them). The start command is `npm start`, which Azure runs automatically.

4. **Lock it down.** It's an internal reporting tool with a live Plex credential —
   restrict access via Azure App Service *Authentication* (Entra ID / company
   login), access restrictions (VPN/IP allow-list), or a private endpoint.

> **Token = a secret.** `PLEX_AUTH` is Base64 of `username:password` for the Plex
> web-service account. App Settings are encrypted at rest in Azure, which is fine
> for an internal tool. For stronger handling, store it in **Azure Key Vault** and
> reference it from App Settings with `@Microsoft.KeyVault(...)` — no code change
> required.

#### A note on the cache in Azure

The `.cache/` folder works on App Service, but it lives on the instance's local
disk: it's **wiped on restart/redeploy** and **not shared across scaled-out
instances**. The only effect is that the **variability** page re-warms its cache
(the ~5-minute cold run) after a restart or on a fresh instance — harmless, just
slower that first time. If you scale to multiple instances and want the warm cache
shared, point the cache at Azure Files or swap it for a small cache service; for a
single-instance internal tool you can ignore this.

## Matching the Power Query exactly

`server.js` mirrors the M logic step-for-step: Sunday week anchoring at UTC-5,
`Date` = end of week / `Date_Orig` = start of week in the request body, the same
column sums, and the same derived fields (`Net_Change`, `YearWeek_Label`, etc.).
If you change the datasource or columns in Plex, update `fetchWeek()` to match.
