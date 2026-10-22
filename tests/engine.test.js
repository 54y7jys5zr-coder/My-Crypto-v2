/* Engine regression tests — run with `npm test` (Node 18+, no dependencies). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { analyze, ptime } = require("../engine.js");

const SAMPLE = path.join(__dirname, "..", "sample_csv");
const read = f => fs.readFileSync(path.join(SAMPLE, f + ".csv"), "utf8");
// sample_csv/ is gitignored (kept off the deployed site); its tests skip on clones without it.
// Regenerate with `node sample_csv/gen.js` from a copy of the generator.
const SAMPLE_OPT = { skip: fs.existsSync(path.join(SAMPLE, "Ledger.csv")) ? false : "sample_csv/ not present (gitignored)" };
const csv = rows => rows.map(r => r.join(",")).join("\n") + "\n";
const LEDGER_H = ["txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"];
const TRADES_H = ["txid","ordertxid","pair","time","type","ordertype","price","cost","fee","vol","margin","misc","ledgers"];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);

test("sample CSVs reproduce the known totals", SAMPLE_OPT, () => {
  const r = analyze(read("Balances"), read("Ledger"), read("Trades"));
  near(r.assets.reduce((s, a) => s + a.cost_basis, 0), 13165.78, "cost basis");
  near(r.meta.net_deposited, 10500, "net deposited");
  near(r.meta.total_realized, 541.93, "realized");
  assert.equal(r.warnings.length, 0);
  assert.equal(r.assets.length, 10);
});

test("basis timeline ends at the total cost basis", SAMPLE_OPT, () => {
  const r = analyze(read("Balances"), read("Ledger"), read("Trades"));
  const tl = r.basis_timeline;
  assert.ok(tl.length > 1);
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i][0] >= tl[i - 1][0], "timeline is chronological");
  near(tl[tl.length - 1][1], r.assets.reduce((s, a) => s + a.cost_basis, 0), "final basis");
});

test("Kraken timestamps parse as UTC", () => {
  assert.equal(ptime("2025-01-02 10:00:00"), Date.UTC(2025, 0, 2, 10));
  assert.equal(ptime("2025-01-02 10:00:00.1234"), Date.UTC(2025, 0, 2, 10));
  assert.equal(ptime("2025-01-02T10:00:00+02:00"), Date.UTC(2025, 0, 2, 8));
});

test("swap legs share cost by refid, and an unmatched EUR buy takes the EUR spent", () => {
  const bal = csv([["asset","wallet","quantity"],["BTC","spot","0.09"],["ETH","spot","1"],["SOL","spot","10"]]);
  const led = csv([LEDGER_H,
    ["a1","D1","2025-01-01 10:00:00","deposit","","currency","EUR","10000","0",""],
    ["a2","T1","2025-01-02 10:00:00","trade","","currency","EUR","-5000","0",""],
    ["a3","T1","2025-01-02 10:00:00","trade","","currency","BTC","0.1","0",""],
    ["a4","T2","2025-01-03 10:00:00","trade","","currency","EUR","-1000","0",""],
    ["a5","T2","2025-01-03 10:00:00","trade","","currency","SOL","10","0",""],
    // sell leg listed BEFORE the buy leg of the same swap
    ["a6","T3","2025-01-04 10:00:00","trade","","currency","BTC","-0.01","0",""],
    ["a7","T3","2025-01-04 10:00:00","trade","","currency","ETH","1","0",""]]);
  const trd = csv([TRADES_H,
    ["t1","o1","BTC/EUR","2025-01-02 10:00:00","buy","market","","4990","10","0.1","0","",""],
    ["t3","o3","ETH/BTC","2025-01-04 10:00:00","buy","market","","0.01","0","1","0","",""]]); // no SOL trade row
  const by = Object.fromEntries(analyze(bal, led, trd).assets.map(a => [a.asset, a]));
  near(by.BTC.cost_basis, 4500, "BTC keeps 90% of its cost");
  near(by.ETH.cost_basis, 500, "ETH inherits the BTC it was swapped from");
  near(by.SOL.cost_basis, 1000, "SOL takes the EUR leg's cost");
  assert.ok(!analyze(bal, led, trd).warnings.some(w => w.unmatched_sale), "swap with the sold leg first isn't an unmatched sale");
});

test("holdings timeline ends at each asset's quantity and deployed units", SAMPLE_OPT, () => {
  const r = analyze(read("Balances"), read("Ledger"), read("Trades"));
  for (const a of r.assets) {
    const tl = r.holdings_timeline[a.asset];
    assert.ok(tl && tl.length, `${a.asset} has a timeline`);
    const [, units, paid] = tl[tl.length - 1];
    near(units, a.quantity, `${a.asset} units`);
    near(paid, a.deployed_units, `${a.asset} paid units`);
  }
});

/* ---- scenarios from the 2026-10-20 review ---- */
const L = (id, ref, time, type, asset, amount, fee="0") => [id, ref, time, type, "", "currency", asset, amount, fee, ""];
const Tr = (txid, pair, time, type, cost, fee="0", vol="0") => [txid, "o"+txid, pair, time, type, "market", "", cost, fee, vol, "0", "", ""];
const run = (balRows, ledRows, trdRows) => analyze(
  csv([["asset","wallet","quantity"], ...balRows]), csv([LEDGER_H, ...ledRows]), csv([TRADES_H, ...trdRows]));
const byAsset = r => Object.fromEntries(r.assets.map(a => [a.asset, a]));

test("withdrawn coins stay in the portfolio with their cost; the fee is spent", () => {
  const r = run([["BTC","spot","0.4995"]],
    [L("a","T1","2025-01-01 10:00:00","trade","EUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","BTC","1"),
     L("c","W1","2025-02-01 10:00:00","withdrawal","BTC","-0.5","0.0005")],
    [Tr("T1","BTC/EUR","2025-01-01 10:00:00","buy","10000")]);
  const b = byAsset(r).BTC;
  near(b.quantity, 0.9995, "total units"); near(b.exchange_units, 0.4995, "on Kraken"); near(b.offexchange_units, 0.5, "off Kraken");
  near(b.cost_basis, 10000, "cost kept"); near(b.deployed_units, 0.9995, "all paid for"); near(b.zero_cost_units, 0, "no free units");
  assert.equal(r.warnings.length, 0, "reconciles to Balances");
  const tl = r.holdings_timeline.BTC; near(tl[tl.length-1][1], 0.9995, "timeline units");
});

test("coins deposited back return with their cost instead of counting as a gift", () => {
  const r = run([["BTC","spot","1"]],
    [L("a","T1","2025-01-01 10:00:00","trade","EUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","BTC","1"),
     L("c","W1","2025-02-01 10:00:00","withdrawal","BTC","-0.5"), L("d","D1","2025-03-01 10:00:00","deposit","BTC","0.5")],
    [Tr("T1","BTC/EUR","2025-01-01 10:00:00","buy","10000")]);
  const b = byAsset(r).BTC;
  near(b.offexchange_units, 0, "nothing left off Kraken"); near(b.gift_units, 0, "not a gift"); near(b.cost_basis, 10000, "cost");
});

test("a sale into EUR without a Trades row books realized from the EUR leg (either order)", () => {
  for (const eurFirst of [false, true]) {
    const sell = [L("c","S1","2025-02-01 10:00:00","trade","BTC","-0.5"), L("d","S1","2025-02-01 10:00:00","trade","EUR","8000","10")];
    if (eurFirst) sell.reverse();
    const r = run([["BTC","spot","0.5"]],
      [L("a","T1","2025-01-01 10:00:00","trade","EUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","BTC","1"), ...sell],
      [Tr("T1","BTC/EUR","2025-01-01 10:00:00","buy","10000")]);
    near(r.meta.total_realized, 2990, `realized (EUR leg ${eurFirst?"first":"second"})`);
    near(byAsset(r).BTC.cost_basis, 5000, "remaining cost");
    assert.equal(r.realized_events.length, 1); near(r.realized_events[0].proceeds, 7990, "proceeds");
  }
});

test("legacy Kraken codes and pairs (XXBT, XXBTZEUR) are understood", () => {
  const r = run([["XXBT","spot","1"],["ZEUR","spot","25"]],
    [L("a","T1","2025-01-01 10:00:00","trade","ZEUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","XXBT","1")],
    [Tr("T1","XXBTZEUR","2025-01-01 10:00:00","buy","9990","10")]);
  const b = byAsset(r).BTC; assert.ok(b, "XXBT maps to BTC");
  near(b.cost_basis, 10000, "cost from the legacy pair"); near(r.meta.cash.EUR, 25, "ZEUR is EUR cash");
});

test("trades are matched by refid/txid, so a nearby trade can't take another's row", () => {
  const r = run([["BTC","spot","0.8"],["ETH","spot","1"]],
    [L("a","T1","2025-01-01 10:00:00","trade","EUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","BTC","1"),
     L("c","S1","2025-02-01 10:00:00","trade","BTC","-0.1"), L("d","S1","2025-02-01 10:00:00","trade","ETH","1"),
     L("e","S2","2025-02-01 10:00:02","trade","BTC","-0.1"), L("f","S2","2025-02-01 10:00:02","trade","EUR","1200")],
    [Tr("T1","BTC/EUR","2025-01-01 10:00:00","buy","10000"), Tr("S1","ETH/BTC","2025-02-01 10:00:00","buy","0.1"),
     Tr("S2","BTC/EUR","2025-02-01 10:00:02","sell","1200")]);
  const by = byAsset(r);
  near(by.ETH.cost_basis, 1000, "ETH inherits the swapped BTC's cost"); near(by.BTC.cost_basis, 8000, "BTC");
  near(r.meta.total_realized, 200, "only the EUR sale is realized");
  assert.equal(r.warnings.length, 0, "a swap is not reported as an unmatched sale");
});

test("fiat balances are cash, not assets; realized events add up", SAMPLE_OPT, () => {
  const r = analyze(read("Balances") + "USD,spot,50\n", read("Ledger"), read("Trades"));
  assert.ok(!r.assets.some(a => a.asset === "USD"), "USD is not an asset"); near(r.meta.cash.USD, 50, "USD cash");
  near(r.realized_events.reduce((s, e) => s + e.pnl, 0), r.meta.total_realized, "per-sale P/L sums to total");
});

test("manual entries: a wallet gift counts at zero cost and is kept apart from Kraken deposits", () => {
  const gift = [{id:"g1", asset:"btc", date:"2020-06-01", units:0.01, kind:"gift"}];
  // only the manual entry, no Kraken data at all
  let r = analyze("", "", "", gift), b = byAsset(r).BTC;
  near(b.quantity, 0.01, "units"); near(b.cost_basis, 0, "gift is free"); near(b.gift_units, 0.01, "gift units");
  near(b.offexchange_units, 0.01, "in private wallet"); near(b.deployed_units, 0, "not invested");
  // an unrelated BTC gift deposited to Kraken must not swallow the manual entry
  r = analyze(csv([["asset","wallet","quantity"],["BTC","spot","0.01"]]),
              csv([LEDGER_H, L("d","D1","2024-01-01 10:00:00","deposit","BTC","0.01")]), csv([TRADES_H]), gift);
  b = byAsset(r).BTC;
  near(b.quantity, 0.02, "0.01 on Kraken + 0.01 in the wallet"); near(b.gift_units, 0.02, "two gifts");
  near(b.exchange_units, 0.01, "on Kraken"); near(b.offexchange_units, 0.01, "private wallet"); assert.equal(r.warnings.length, 0);
});

test("manual entries: coins bought elsewhere carry their cost", () => {
  const r = analyze("", "", "", [{id:"p1", asset:"ETH", date:"2022-03-01", units:2, kind:"purchase", cost_eur:3000}]);
  const e = byAsset(r).ETH;
  near(e.cost_basis, 3000, "cost"); near(e.deployed_units, 2, "invested"); near(r.basis_timeline.at(-1)[1], 3000, "timeline");
});

test("transaction events carry amounts for the history list and the tax helper", () => {
  const r = run([["BTC","spot","0.39"],["ETH","spot","1"]],
    [L("a","T1","2025-01-01 10:00:00","trade","EUR","-10000"), L("b","T1","2025-01-01 10:00:00","trade","BTC","1"),
     L("c","S1","2025-02-01 10:00:00","trade","BTC","-0.1"), L("d","S1","2025-02-01 10:00:00","trade","ETH","1"),
     L("e","S2","2025-03-01 10:00:00","trade","BTC","-0.5"), L("f","S2","2025-03-01 10:00:00","trade","EUR","8000","10"),
     L("g","W1","2025-04-01 10:00:00","withdrawal","BTC","-0.01")],
    [Tr("T1","BTC/EUR","2025-01-01 10:00:00","buy","9990","10"), Tr("S1","ETH/BTC","2025-02-01 10:00:00","buy","0.1")]);
  const ev = r.events;
  const buy = ev.find(e => e.type==="buy" && e.asset==="BTC");
  assert.ok(buy.fiat); near(buy.eur, 10000, "fiat buy incl. fee"); near(buy.fee, 10, "buy fee");
  const swapOut = ev.find(e => e.type==="sell" && e.asset==="BTC" && e.via==="ETH"), swapIn = ev.find(e => e.type==="buy" && e.asset==="ETH");
  assert.ok(swapOut && !swapOut.fiat, "swap out isn't a fiat sale"); near(swapIn.eur, 1000, "swap carries cost"); assert.equal(swapIn.via, "BTC");
  const sale = ev.find(e => e.type==="sell" && e.fiat);
  near(sale.gross, 8000, "gross proceeds (EUR leg)"); near(sale.fee, 10, "sale fee"); near(sale.eur, 7990, "net proceeds");
  assert.ok(ev.some(e => e.type==="withdrawal" && Math.abs(e.units-0.01)<1e-9), "withdrawal listed");
});
