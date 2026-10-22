/* Portfolio FIFO cost engine — JS port of the validated Python engine.
   Same rules: units = amount - fee; wrapper folding; strict chronological FIFO;
   staking/earn/gifts = zero cost; withdrawn coins stay yours ("held off Kraken") with their cost;
   residual vs Balances reconciled as zero-cost (surplus) or removed FIFO (shortfall).
   Regression checkpoints (EUR): total cost basis 4354.14, net deposited 3553.24, realized 978.24
   (real data, before the 2026-10 withdrawal/realized fixes). */

const CG_ID_OVERRIDES = {
  BTC:"bitcoin",ETH:"ethereum",LTC:"litecoin",ADA:"cardano",DOT:"polkadot",ATOM:"cosmos",
  ALGO:"algorand",ARB:"arbitrum",AKT:"akash-network",EIGEN:"eigenlayer",FET:"fetch-ai",
  LINK:"chainlink",MINA:"mina-protocol",PEPE:"pepe",POL:"polygon-ecosystem-token",
  RENDER:"render-token",SUPER:"superfarm",XRP:"ripple",
  SOL:"solana",DOGE:"dogecoin",USDT:"tether",USDC:"usd-coin",XLM:"stellar",ETC:"ethereum-classic",XTZ:"tezos",
  AVAX:"avalanche-2",TRX:"tron",BNB:"binancecoin",ATOM21:"cosmos"
};
const SPECIAL = {ETH2:"ETH","ETH2.S":"ETH","BTC.M":"BTC",MATIC:"POL","MATIC.S":"POL","MATIC04.S":"POL",RNDR:"RENDER",
  // Kraken's legacy X/Z-prefixed codes (older exports)
  XBT:"BTC",XXBT:"BTC",XETH:"ETH",XLTC:"LTC",XXRP:"XRP",XXLM:"XLM",XXDG:"DOGE",XDG:"DOGE",XETC:"ETC",XZEC:"ZEC",XXMR:"XMR",
  ZEUR:"EUR",ZUSD:"USD",ZGBP:"GBP",ZCAD:"CAD",ZJPY:"JPY",ZAUD:"AUD",ZCHF:"CHF"};
/* fiat balances are cash, not assets */
const FIAT = new Set(["EUR","USD","GBP","CHF","CAD","AUD","JPY","PLN","SEK","NOK","DKK","CZK"]);
/* quote codes tried when a legacy pair has no "/" (e.g. XXBTZEUR, ETHEUR) — longest first */
const QUOTES = ["ZEUR","ZUSD","ZGBP","ZCAD","ZJPY","ZCHF","XXBT","XETH","USDT","USDC","EUR","USD","GBP","CAD","JPY","CHF","XBT","ETH","BTC"];

function baseAsset(a){
  if(a==null) return null;
  a=String(a).trim();
  if(SPECIAL[a]) return SPECIAL[a];
  if(a.includes(".")){ let h=a.split(".")[0].replace(/\d+$/,""); return SPECIAL[h]||h; }
  return a;
}
/* "BTC/EUR" or legacy "XXBTZEUR" -> {base, quote} (normalized), or null */
function splitPair(p){
  p=String(p||"").trim(); if(!p) return null;
  if(p.includes("/")){ const [b,q]=p.split("/"); return {base:baseAsset(b), quote:baseAsset(q)}; }
  for(const q of QUOTES){ if(p.length>q.length && p.endsWith(q)) return {base:baseAsset(p.slice(0,-q.length)), quote:baseAsset(q)}; }
  return null;
}
function tsec(s){ return String(s).split(".")[0]; }
function ptime(s){
  if(!s) return 0;
  // Kraken exports are UTC with no offset: "YYYY-MM-DD HH:MM:SS[.f]". Parse as UTC explicitly —
  // an offset-less ISO string is read as LOCAL time, which breaks the ±3s trade matching below.
  s=String(s).trim();
  const m=/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(s);
  const t = Date.parse(m ? `${m[1]}T${m[2]}Z` : s);
  return isNaN(t) ? 0 : t;
}
function tonum(v){
  if(v==null||v==="") return 0;
  if(typeof v==="number") return v;
  const n=parseFloat(String(v).replace(/,/g,""));
  return isNaN(n)?0:n;
}
function norm(h){ return h==null?"":String(h).toLowerCase().replace(/[^a-z0-9]/g,""); }

/* CSV parser (handles quoted fields, commas, newlines). Returns {header, rows}. */
function parseCSV(text){
  const rows=[]; let field="",row=[],inq=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inq){
      if(c=='"'){ if(text[i+1]=='"'){field+='"';i++;} else inq=false; }
      else field+=c;
    } else {
      if(c=='"') inq=true;
      else if(c==','){ row.push(field); field=""; }
      else if(c=='\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else if(c=='\r'){ /* skip */ }
      else field+=c;
    }
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  const header=rows.shift()||[];
  return {header, rows: rows.filter(r=>r.length>1 || (r.length===1 && r[0]!==""))};
}

const SPEC = {
  balances:{asset:["asset"],wallet:["wallet"],quantity:["quantity","balance","amount","vol"]},
  ledger:{refid:["refid"],time:["time"],type:["type"],subtype:["subtype"],asset:["asset"],amount:["amount"],fee:["fee"]},
  trades:{txid:["txid"],pair:["pair"],time:["time"],type:["type"],cost:["cost"],fee:["fee"],vol:["vol","volume"]}
};
const OPTIONAL=new Set(["subtype","refid","txid","wallet"]);

function mapper(header, spec, label){
  const nh=header.map(norm), idx={};
  for(const [logical,aliases] of Object.entries(spec)){
    let found=-1;
    for(const al of aliases){ const j=nh.indexOf(norm(al)); if(j>=0){found=j;break;} }
    idx[logical]=found;
  }
  const missing=Object.entries(idx).filter(([k,v])=>v<0 && !OPTIONAL.has(k)).map(([k])=>k);
  if(missing.length) throw new Error(`${label}: missing columns ${missing.join(", ")}. Headers: ${header.join(", ")}`);
  return (row,name)=>{ const i=idx[name]; if(i<0||i>=row.length) return null; const v=row[i]; return v===""?null:v; };
}

/* Main engine: takes Balances, Ledger and Trades CSV strings (any may be empty) and optional
   manual entries for coins held outside Kraken:
     [{id, asset, date:"YYYY-MM-DD", units, kind:"gift"|"purchase", cost_eur}]
   Returns {assets, meta, warnings, events, basis_timeline, holdings_timeline, realized_events}. */
const EMPTY_CSV = { balances:"asset,wallet,quantity\n", ledger:"refid,time,type,subtype,asset,amount,fee\n", trades:"txid,pair,time,type,cost,fee,vol\n" };
function analyze(balancesText, ledgerText, tradesText, manual){
  const B=parseCSV(balancesText||EMPTY_CSV.balances), L=parseCSV(ledgerText||EMPTY_CSV.ledger), T=parseCSV(tradesText||EMPTY_CSV.trades);
  const manualEntries=(Array.isArray(manual)?manual:[]).map(m=>({...m, asset:baseAsset(String(m.asset||"").toUpperCase()),
    units:tonum(m.units), cost:m.kind==="purchase"?Math.max(0,tonum(m.cost_eur)):0, t:ptime(String(m.date||"")+" 00:00:00")}))
    .filter(m=>m.asset && m.units>0 && m.t>0);
  const bc=mapper(B.header,SPEC.balances,"Balances");
  const lc=mapper(L.header,SPEC.ledger,"Ledger");
  const tc=mapper(T.header,SPEC.trades,"Trades");

  // balances ground truth (exchange only)
  const bal={};
  for(const r of B.rows){ const a=bc(r,"asset"); if(a==null||a==="Total") continue;
    const b=baseAsset(a); bal[b]=(bal[b]||0)+tonum(bc(r,"quantity")); }

  // Trades. On Kraken a ledger row's refid is the trade's txid, so that is the exact match;
  // otherwise fall back to (second, base asset, direction) within ±3s, skipping trades that
  // another ledger row claims by refid.
  const ledgerRefs=new Set(L.rows.map(r=>lc(r,"refid")).filter(Boolean));
  const byTxid=new Map(), byKey=new Map();
  for(const r of T.rows){ const pp=splitPair(tc(r,"pair")); if(!pp||!pp.base) continue;
    const tr={txid:tc(r,"txid"), base:pp.base, quote:pp.quote, cost:tonum(tc(r,"cost")), fee:tonum(tc(r,"fee")),
              typ:String(tc(r,"type")||"").toLowerCase(), used:false};
    if(tr.txid) byTxid.set(tr.txid, tr);
    const key=tsec(tc(r,"time"))+"|"+tr.base;
    if(!byKey.has(key)) byKey.set(key,[]);
    byKey.get(key).push(tr); }
  function matchTrade(t, b, dir, ref){
    if(ref && byTxid.has(ref)){ const tr=byTxid.get(ref); if(!tr.used && tr.base===b){ tr.used=true; return tr; } }
    const want = dir>0 ? "buy" : "sell";
    const ok = tr => !tr.used && (!tr.typ || tr.typ===want) && !(tr.txid && tr.txid!==ref && ledgerRefs.has(tr.txid));
    const bt=ptime(t);
    for(const d of [0,1,-1,2,-2,3,-3]){
      const k=(d===0 ? tsec(t) : new Date(bt+d*1000).toISOString().replace("T"," ").slice(0,19))+"|"+b;
      const tr=(byKey.get(k)||[]).find(ok);
      if(tr){ tr.used=true; return tr; }
    }
    return null;
  }

  // events sorted by time (stable via index); manual entries sit at 00:00 UTC of their date
  const evts=L.rows.map((r,i)=>({t:ptime(lc(r,"time")),i,r}))
    .concat(manualEntries.map((m,j)=>({t:m.t, i:-1-j, manual:m})))
    .sort((x,y)=> x.t-y.t || x.i-y.i);

  // lots = on Kraken; ext = withdrawn from Kraken (can come back via a deposit);
  // man = entered manually (private wallet, never matched against Kraken deposits)
  const lots={}, ext={}, man={}, realized={}, rewardU={}, giftU={};
  const pend=[];             // no-refid fallback: non-EUR buys awaiting a cost, FIFO
  // Both legs of one trade share a ledger refid. A leg bought without an EUR price takes its cost
  // from the leg spent in the same refid, whichever of the two is processed first.
  const pendLot=new Map();   // refid -> lot waiting for its counter-leg's cost
  const pendCost=new Map();  // refid -> cost of a counter-leg seen before the lot
  // A sale into EUR without a matching Trades row is booked from its EUR ledger leg instead.
  const pendSell=new Map();  // refid -> {asset, units, rc, t} waiting for the EUR proceeds
  const pendEur=new Map();   // refid -> EUR proceeds seen before the crypto leg
  const events=[];           // {t, asset, type:"buy"|"sell"} — chart annotations
  const realized_events=[];  // {t, asset, units, proceeds, cost, pnl} — EUR, one per sale
  let feesEur=0;
  const push=(o,k,v)=>{o[k]=(o[k]||0)+v;};
  const bookSale=(t,a,units,proceeds,cost)=>{ push(realized,a,proceeds-cost);
    realized_events.push({t, asset:a, units, proceeds, cost, pnl:proceeds-cost}); };
  /* remove u units FIFO from a lot list; returns the removed pieces [[units,costPerUnit],…] */
  function take(dq,u){
    const out=[]; let need=u;
    while(need>1e-12 && dq.length){ const lot=dq[0]; const x=Math.min(lot[0],need);
      out.push([x,lot[1]]); lot[0]-=x; need-=x; if(lot[0]<=1e-12) dq.shift(); }
    return out;
  }
  const costOf = pieces => pieces.reduce((s,[u,c])=>s+u*c,0);
  const consume = (a,u) => costOf(take(lots[a]||(lots[a]=[]),u));

  // assets reported = held on the exchange or off it (withdrawn); computed at the end, but the
  // timelines need the set up front: anything in Balances or ever withdrawn
  const fiat = a => FIAT.has(a);
  const everWithdrawn=new Set(L.rows.filter(r=>lc(r,"type")==="withdrawal").map(r=>baseAsset(lc(r,"asset"))).filter(a=>a&&!fiat(a)));
  const held=[...new Set([...Object.keys(bal),...everWithdrawn,...manualEntries.map(m=>m.asset)])].filter(a=>!fiat(a));
  const allLots = a => (lots[a]||[]).concat(ext[a]||[], man[a]||[]);
  // cost-basis timeline: total basis of tracked assets (exchange + off-exchange lots)
  const basisNow=()=>{ let s=0; for(const a of held) for(const [u,c] of allLots(a)) s+=u*c; return s; };
  // holdings timeline per asset: [t, units (exchange + off-exchange), paid-for units]
  const unitsNow=a=>{ let u=0,p=0; for(const [x,c] of allLots(a)){ u+=x; if(c>0) p+=x; } return [u,p]; };
  const basis_timeline=[], holdings_timeline={}, touched=new Set();
  for(let ei=0; ei<evts.length; ei++){
    const b=step(evts[ei]); if(b && held.includes(b)) touched.add(b);
    if(ei===evts.length-1 || evts[ei+1].t!==evts[ei].t){
      const t=evts[ei].t, v=basisNow(), last=basis_timeline[basis_timeline.length-1];
      if(!last || Math.abs(last[1]-v)>1e-9) basis_timeline.push([t, v]);
      for(const a of touched) (holdings_timeline[a]||(holdings_timeline[a]=[])).push([t, ...unitsNow(a)]);
      touched.clear();
    }
  }
  // Each event records what happened for the transaction list and the tax helper:
  // {t, asset, type:"buy"|"sell"|"deposit"|"withdrawal"|"manual", units,
  //  eur (cost for buys, net proceeds for sales, carried cost for swaps), fiat (paid/received in EUR),
  //  gross/fee (EUR sales), via (the other coin in a swap), kind (manual: gift|purchase)}
  const pendEv=new Map();    // refid -> buy event waiting for its cost (mirrors pendLot)
  function step({t:evT, r, manual:me}){
    if(me){                                                   // held outside Kraken from that date
      const b=me.asset; (lots[b]||(lots[b]=[]));
      (man[b]||(man[b]=[])).push([me.units, me.cost/me.units]);
      if(me.kind==="gift") push(giftU,b,me.units);
      events.push({t:evT, asset:b, type:"manual", kind:me.kind, units:me.units, ...(me.kind==="purchase"?{eur:me.cost}:{})});
      return b;
    }
    const typ=lc(r,"type"), sub=lc(r,"subtype"), asset=lc(r,"asset");
    const amt=tonum(lc(r,"amount")), fee=tonum(lc(r,"fee")); const b=baseAsset(asset);
    const ref=lc(r,"refid");
    // hand a cost to the bought leg of this refid; src = "EUR" (paid in euros) or the coin given up
    const giveCost=(rc,src)=>{ const lot=pendLot.get(ref);
      if(lot){ pendLot.delete(ref); lot[1]=lot[0]?rc/lot[0]:0;
        const ev=pendEv.get(ref); if(ev){ pendEv.delete(ref); ev.eur=rc; if(src==="EUR") ev.fiat=true; else ev.via=src; } }
      else pendCost.set(ref,{rc,src}); };
    if(b==null) return;
    if(b==="EUR"){
      if(typ==="trade" && ref){
        if(amt<0) giveCost(-amt+fee,"EUR");                   // EUR spent: cost for the bought leg
        else if(amt>0){ const s=pendSell.get(ref);           // EUR received: a sale
          if(s){ pendSell.delete(ref); bookSale(s.t,s.asset,s.units,amt-fee,s.rc); Object.assign(s.ev,{eur:amt-fee,gross:amt,fee,fiat:true}); }
          else pendEur.set(ref,{gross:amt,fee}); }
      }
      return;
    }
    if(fiat(b)) return;                                       // other fiat: cash, not tracked as an asset
    const net=amt-fee; (lots[b]||(lots[b]=[]));
    if(typ==="trade"){
      const ev={t:evT, asset:b, type: amt>0?"buy":"sell", units:Math.abs(net)};
      events.push(ev);
      const tr=ref && byTxid.get(ref), other = tr ? (tr.base===b ? tr.quote : tr.base) : null;
      if(amt>0){
        const m=matchTrade(lc(r,"time"),b,+1,ref);
        if(m && m.quote==="EUR"){ const eur=m.cost+m.fee; feesEur+=m.fee; lots[b].push([net, net?eur/net:0]); Object.assign(ev,{eur,fee:m.fee,fiat:true}); }
        else if(ref){ const lot=[net,0]; lots[b].push(lot);
          if(pendCost.has(ref)){ const {rc,src}=pendCost.get(ref); pendCost.delete(ref); lot[1]=net?rc/net:0; pendSell.delete(ref);
            ev.eur=rc; if(src==="EUR") ev.fiat=true; else ev.via=src; }
          else { pendLot.set(ref,lot); pendEv.set(ref,ev); } }
        else if(m){ const lot=[net,0]; lots[b].push(lot); pend.push([b,lot]); ev.via=m.quote; }
        else lots[b].push([net,0]);
      } else {
        const units=Math.abs(net);
        const m=matchTrade(lc(r,"time"),b,-1,ref); const rc=consume(b,units);
        if(m && m.quote==="EUR"){ feesEur+=m.fee; bookSale(evT,b,units,m.cost-m.fee,rc); Object.assign(ev,{eur:m.cost-m.fee,gross:m.cost,fee:m.fee,fiat:true}); }
        else if(ref){
          // crypto-to-crypto swap (the trade isn't EUR-quoted, or the received leg is already waiting):
          // the cost moves to the received coin, nothing is realized
          const swap=pendLot.has(ref) || (tr && tr.quote!=="EUR");
          giveCost(rc, b);
          if(swap){ ev.eur=rc; if(other) ev.via=other; }
          else {                                              // otherwise EUR proceeds arrive in the same refid
            if(pendEur.has(ref)){ const p=pendEur.get(ref); pendEur.delete(ref); bookSale(evT,b,units,p.gross-p.fee,rc);
              Object.assign(ev,{eur:p.gross-p.fee,gross:p.gross,fee:p.fee,fiat:true}); }
            else pendSell.set(ref,{asset:b,units,rc,t:evT,ev});
          }
        }
        else if(pend.length){ const [,lot]=pend.shift(); lot[1]=lot[0]?rc/lot[0]:0; ev.eur=rc; }
      }
    } else if(typ==="staking" && (sub==null||sub==="")){ lots[b].push([net,0]); push(rewardU,b,net); }
    else if(typ==="earn" && sub==="reward"){ lots[b].push([net,0]); push(rewardU,b,net); }
    else if(typ==="deposit"){
      // coins coming back from your own wallet return with their cost; anything beyond that is a gift
      const back=take(ext[b]||(ext[b]=[]), net);
      for(const p of back) lots[b].push(p);
      const backU=back.reduce((s,[u])=>s+u,0), gift=net-backU;
      if(gift>1e-12){ lots[b].push([gift,0]); push(giftU,b,gift); }
      events.push({t:evT, asset:b, type:"deposit", units:net, ...(gift>1e-12?{gift}:{})});
    }
    else if(typ==="withdrawal"){
      // the coins stay yours, held off the exchange; the network fee is spent, its cost moves with them
      const out=Math.abs(amt), pieces=take(lots[b], out+fee);
      const total=pieces.reduce((s,[u])=>s+u,0);
      // scale the removed lots down to what arrived (fee units vanish, their cost doesn't); if the
      // ledger shows fewer coins than were withdrawn, keep what we have unscaled
      if(total>1e-12){ const k = total>=out ? out/total : 1;
        for(const [u,c] of pieces) (ext[b]||(ext[b]=[])).push([u*k, c/k]); }
      events.push({t:evT, asset:b, type:"withdrawal", units:out, fee});
    }
    // else: internal transfer/allocation/migration -> ignore
    return b;
  }

  // EUR flows
  let dep=0,wd=0;
  for(const r of L.rows){ if(baseAsset(lc(r,"asset"))!=="EUR") continue;
    const typ=lc(r,"type"), amt=tonum(lc(r,"amount"));
    if(typ==="deposit") dep+=amt; else if(typ==="withdrawal") wd+=Math.abs(amt); }

  const assets=[], warnings=[];
  for(const a of held.slice().sort()){
    const exLots=lots[a]||(lots[a]=[]), offLots=(ext[a]||[]).concat(man[a]||[]);
    const q=bal[a]||0;
    const onEx=exLots.reduce((s,[u])=>s+u,0);
    const residual=q-onEx;
    // reconcile the exchange part to Balances: surplus = zero-cost units, shortfall = removed FIFO
    if(Math.abs(residual) > Math.max(1e-6, q*1e-6)){
      if(residual>0) exLots.push([residual,0]); else take(exLots,-residual);
      warnings.push({asset:a, quantity:q, reconstructed:onEx, residual_zero_cost:residual});
    }
    const off=offLots.reduce((s,[u])=>s+u,0);
    if(q<=1e-12 && off<=1e-12) continue;                      // fully sold: nothing left to report
    let basis=0, paid=0;
    for(const [u,c] of exLots.concat(offLots)){ basis+=u*c; if(c>0) paid+=u; }
    const quantity=q+off;
    assets.push({asset:a, cg_id:CG_ID_OVERRIDES[a]||a.toLowerCase(), quantity, cost_basis:basis,
                 deployed_units:paid, zero_cost_units:quantity-paid,
                 exchange_units:q, offexchange_units:off,
                 reward_units:rewardU[a]||0, gift_units:giftU[a]||0,
                 realized:realized[a]||0});
  }
  // reconciliation can change units/basis: close the timelines on the final state
  if(evts.length){ const tEnd=evts[evts.length-1].t, v=basisNow(), last=basis_timeline[basis_timeline.length-1];
    if(!last || Math.abs(last[1]-v)>1e-9) basis_timeline.push([tEnd, v]);
    for(const a of held){ const tl=holdings_timeline[a], [u,p]=unitsNow(a), l=tl&&tl[tl.length-1];
      if(!l || Math.abs(l[1]-u)>1e-9 || Math.abs(l[2]-p)>1e-9) (holdings_timeline[a]||(holdings_timeline[a]=[])).push([tEnd,u,p]); } }
  // sales of assets no longer held still count toward realized
  const totalRealized=Object.values(realized).reduce((s,v)=>s+v,0);
  for(const [ref,s] of pendSell) warnings.push({asset:s.asset, unmatched_sale:ref});
  assets.sort((x,y)=>y.cost_basis-x.cost_basis);
  const cash={}; for(const [a,v] of Object.entries(bal)) if(fiat(a) && Math.abs(v)>1e-9) cash[a]=v;
  const meta={total_deposited:dep,total_withdrawn:wd,net_deposited:dep-wd,
              eur_remaining:bal["EUR"]||0, cash, total_realized:totalRealized, total_fees_eur:feesEur};
  realized_events.sort((x,y)=>x.t-y.t);
  return {assets, meta, warnings, events, basis_timeline, holdings_timeline, realized_events};
}

if(typeof module!=="undefined" && module.exports) module.exports={analyze, parseCSV, baseAsset, ptime, splitPair};
if(typeof window!=="undefined") window.PortfolioEngine={analyze, parseCSV, baseAsset, FIAT};
