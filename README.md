# My Crypto

A private-by-design crypto portfolio tracker: effective cost, current value and P/L, running entirely on your device. A minimal, mobile-first PWA for Kraken exports with live prices, **14 display currencies**, a portfolio chart built from your actual holdings over time, per-coin details and transaction history, alerts, an optional Polish tax (PIT-38) helper and light/dark themes — backed by a strict-FIFO cost engine in JavaScript.

**Live site:** https://54y7jys5zr-coder.github.io/My-Crypto/

## Features

- **Overview** — value and P/L, 24h / 7d / 30d change chips and one info line (lifetime P/L · cash on Kraken · freshness), then the value chart (**1W / 1M / 1Y**, with date and value labels) built from **the holdings you actually had on each day** against a **step cost-basis line**, with buy/sell markers. Scrub with a finger, mouse or the arrow keys to see any day's value, cost basis, P/L and market move (best/worst day exclude your own purchases and sales). Below: a swipeable stats row, key stats (net invested, 24h change, realized, top mover), your **top 3 holdings** and a **tappable allocation** bar. A reminder appears when your imported data is more than two weeks old.
- **Portfolio** — one screen with a **List / Table** switch: searchable, sortable holdings (list sort and table column headers stay in sync), coin logos, 24h change, 7-day sparklines, a summary with staking rewards, cash, trading fees and **realized P/L per tax year** (with a per-sale CSV export in EUR), **CSV export** and share. The summary sections (Headline, EUR flows, Realized by year, optional PIT-38) collapse. Tap a coin for a detail sheet — swipe or use ‹ › to move between coins — with a transaction list with a 1W/1M/1Y chart, 7d/30d change, cost breakdown (incl. rewards, gifts, and how much is on Kraken vs. in your private wallet), break-even and **price alerts** (rises to / falls to) that show a badge and, if allowed, a notification while the app is open.
- **Settings** — collapsible sections (Kraken data, Holdings outside Kraken, Backup & restore, API key, Display, About), each showing a one-line status when closed; open/closed state is remembered. **One-step CSV import**: pick or drop the Balances, Ledger and Trades exports together (each is recognised by its columns), preview the result, then import. Unknown coins are matched to CoinGecko automatically. **Holdings outside Kraken**: add coins held in a private wallet that never went through Kraken (a gift, or coins bought elsewhere with their cost); they're saved on the device and counted in your totals. The CSVs you import are kept on the device (IndexedDB) so the portfolio recomputes when you add or remove a holding, without re-importing. **Backup / restore** to a JSON file, a confirmed "Clear imported data", **Undo** for import / restore / clear, text size, auto-refresh (persisted, paused in the background) and an optional CoinGecko demo API key.
- **Alerts** — per coin (rises to / falls to / moves ±% in 24h) and for the portfolio total; all listed in Settings › Alerts.
- **Polish tax helper (optional)** — Settings › Display › Polish tax helper adds a PIT-38 summary: crypto purchases count as costs in the year paid, unused costs carry forward, swaps aren't taxed, EUR → PLN at the NBP rate of the last business day before each transaction; with a CSV worksheet. An estimate, not tax advice.
- **Themes** — Auto, Light or Dark (Settings › Display).
- **Sample data** — "Try with sample data" on the empty screen shows an invented portfolio, kept in memory only.
- **Privacy mode** — one tap on the eye icon hides every amount (percentages stay) for using the app in public.
- **Accessible** — keyboard navigable (modal sheet with focus trap and Escape), `aria-pressed`/`aria-sort`/`aria-current`, visible focus rings, ≥4.5:1 text contrast in dark and light themes, minimum text size, Dynamic Type scaling and reduced-motion support.
- **Offline-capable PWA** — installable, works without a connection (network-first shell with a 3s timeout), asks the browser to keep its storage, and has shortcuts to Portfolio and Import.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 — the service worker needs localhost (or HTTPS).

## Deploy on GitHub Pages

1. Push this folder to the root of a GitHub repo's `main` branch.
2. Repo **Settings → Pages** → Source: `main` branch, folder `/ (root)`.
3. Open https://\<user\>.github.io/\<repo\>/ — HTTPS is required for PWAs.

### Install on iPhone (Safari)

- Open the URL in **Safari** → **Share** → **Add to Home Screen**.
- Launch from the home-screen icon: runs full-screen, works offline, keeps your imported data.
- Note (iOS): installed PWAs get limited storage and unused data can be evicted after ~7 days. Keep your CSV exports as the source of truth.

## Files

- `index.html`, `styles.css`, `app.js` — UI (bottom nav, overview, portfolio, settings)
- `theme.js` — applies a forced light/dark theme before first paint (tiny, loaded in `<head>`)
- `engine.js` — strict-FIFO cost engine (JS); also emits cost-basis and holdings timelines for the chart
- `tests/engine.test.js` — engine regression tests (`npm test`, Node 18+, no dependencies); tests that need the local-only `sample_csv/` fixtures skip when it's absent
- `chart.umd.min.js` — self-hosted charting library (no CDN)
- `data.json` — starter dataset (empty in the repo; import your own CSVs in Settings)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA install + offline shell
- `screenshots/` — install-dialog screenshots, generated from the built-in sample data (no real portfolio)

## Data / method notes

- Balances are ground truth; strict-FIFO builds the cost basis; staking rewards, gifts and airdrops are zero-cost and dilute the average.
- Prices: CoinGecko (EUR). FX: frankfurter.dev (ECB rates) with a CoinGecko fallback. Values are converted into your chosen display currency (default EUR/PLN pair).
- The value chart replays your ledger: each day uses the units you held then, scaled so today ties to Balances. Data imported with older versions has no timeline and falls back to today's holdings with a flat cost line — re-import to upgrade.
- Crypto-to-crypto swaps carry cost from the coin you gave up to the coin you received (ledger `refid` = trade `txid`).
- **Withdrawn coins stay in your portfolio** as "in private wallet", with their cost (the network fee is spent). They're included in each coin's total; the coin's detail sheet shows the Kraken / private-wallet split. Coins deposited back return with their cost; other deposits count as free coins. The app can't see what happens to coins after they leave Kraken.
- Sales into EUR are booked from the Trades file, or from the ledger's EUR amount when the Trades row is missing. Legacy Kraken codes (`XXBT`, `XXBTZEUR`, `ZEUR`) are understood. Fiat balances are shown as cash, not as assets.
- Manual holdings are kept separate from Kraken deposits. If you later move such coins to Kraken, delete the manual entry so they aren't counted twice.
- Realized P/L per year uses UTC calendar years and EUR amounts; check your local tax rules (some countries require a different rate source or method).
- CoinGecko's free/demo history covers 365 days, so 1Y is the longest chart range.
- The optional CoinGecko **demo API key** is a free, public key offered by CoinGecko for evaluation. It is stored in your browser, sent only to `api.coingecko.com` (as an `x-cg-demo-api-key` header) and never leaves the device in any other way.

**Analysis/accounting tool — not tax or investment advice.**

## Security posture

Static, client-side app with **no backend, no accounts, and no PII**. All computation runs on your device; the only outbound calls are read-only price/FX lookups (plus logo images, and your optional demo key if you add one).

Hardening applied before deployment:

- **Content-Security-Policy** (meta tag): `default-src 'self'`; scripts and styles only from self (no inline scripts or styles, no eval — dynamic sizes/colours are set via the CSSOM); images only from self / data / `coin-images.coingecko.com` / `assets.coingecko.com`; network limited to `api.coingecko.com`, `api.frankfurter.dev` and `api.nbp.pl` (only when the Polish tax helper is on; it sends date ranges, nothing about you).
- **Output escaping**: all untrusted strings (CSV asset symbols, API fields) are HTML-escaped before rendering, preventing DOM-XSS from a crafted CSV.
- **No CDN**: the chart library is self-hosted (no third-party script trust; fully offline).
- **URL encoding**: asset IDs are `encodeURIComponent`-ed into API URLs.
- **Service worker** caches only the app shell, never API responses.

What leaves your device: the CoinGecko coin IDs you hold (in the price query string), a currency-pair request for FX, logo image fetches from `coin-images.coingecko.com`, and — only if you added one — your demo API key in a header to `api.coingecko.com`. Quantities, cost basis and P/L never leave the browser.

Residual considerations:

- Holdings, last prices, alerts and your optional API key are stored in the browser's `localStorage`/cache — anyone with access to the unlocked device could open the app. Don't keep secrets in it, and use only a **demo** (public) CoinGecko key, not a paid one.
- GitHub Pages can't set HTTP security headers; the CSP ships via the meta tag. `frame-ancestors` only works as a header, so clickjacking protection needs a host that supports headers — there, also send CSP with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and HSTS.
- Backup files contain your full imported portfolio in plain JSON (not the API key). Store them like any financial record.
- Third-party APIs (CoinGecko, frankfurter.dev) are trusted for price data only; their responses are treated as untrusted input (escaped, numeric-parsed).

## License

MIT — see [LICENSE](LICENSE).