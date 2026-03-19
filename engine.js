/* ═══════════════════════════════════════════════════════════════════════
   BACKTEST V6 ENGINE — extracted from backtest_v6.html
   Standalone module: no DOM, no fetch. Pure computation.
   Usage: import via <script src="engine.js"></script>, all functions on window.
   ═══════════════════════════════════════════════════════════════════════ */

const BLACKLIST = new Set(['MOEX','IRAO','FEES']);
const MIN_BARS = 100;

/* ── Default config (matches V6 UI defaults) ── */
function defaultCfg() {
  return {
    capital:1000000, startYear:2015,
    maxPos1:2, maxPos2:2,
    commission:0.0005, slippage:0.001,
    oosYear:2023, rebal:'none',
    volMin:3.6, maxVr:10,
    sigDays:1, atrMin:1.5,
    atrWin:20, maPeriod:50,
    maFilter:'above', bullBar:true,
    cpMin:0.45, maxDayRet:10,
    vrConfirm:2.0, gapCancel:6,
    volWin:60, liq:100e6,
    stopPct:28, divGap:3,
    rotMult:1.5, rotAbs:0.5,
    tiers:[
      {name:'ULTRA', minVr:7.0, maxHold:15, tsAfter:6, tsDist:2.6},
      {name:'STRONG',minVr:6.5, maxHold:13, tsAfter:6, tsDist:1.8},
      {name:'BASE',  minVr:3.6, maxHold:10, tsAfter:5, tsDist:1.4},
    ],
  };
}

/* ── Costs ── */
function getCostIn(cfg)  { return cfg.commission + cfg.slippage; }
function getCostOut(cfg) { return cfg.commission + cfg.slippage; }

/* ═══════════════════════════════════════════════════════════════════════
   INDICATORS
   ═══════════════════════════════════════════════════════════════════════ */
function avgVol(data, i, volWin) {
  if (i < volWin) return null;
  let s = 0, cnt = 0;
  for (let k = i - volWin; k < i; k++) { if (data[k].v > 0) { s += data[k].v; cnt++; } }
  return cnt < volWin * 0.7 ? null : s / cnt;
}

function maVal(data, i, period) {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += data[k].c;
  return s / period;
}

function closePos(bar) {
  const rng = bar.h - bar.l;
  return rng > 0 ? (bar.c - bar.l) / rng : 0.5;
}

function atrPct(data, i, win) {
  if (i < 2) return 0;
  const start = Math.max(1, i - win);
  let sum = 0, cnt = 0;
  for (let k = start; k < i; k++) {
    const hi = data[k].h > 0 ? data[k].h : data[k].c;
    const lo = data[k].l > 0 ? data[k].l : data[k].c;
    const pc = data[k-1].c > 0 ? data[k-1].c : data[k].c;
    sum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    cnt++;
  }
  return cnt > 0 && data[i].c > 0 ? (sum / cnt) / data[i].c * 100 : 0;
}

function avgValueRub(data, i, win) {
  if (win === undefined) win = 200;
  let s = 0, cnt = 0;
  for (let k = Math.max(0, i - win + 1); k <= i; k++) {
    if (data[k].c > 0 && data[k].v > 0) { s += data[k].c * data[k].v; cnt++; }
  }
  return cnt > 0 ? s / cnt : 0;
}

function dayRet(data, i) {
  if (i > 0 && data[i-1].c > 0) return (data[i].c / data[i-1].c - 1) * 100;
  if (data[i].o > 0) return (data[i].c / data[i].o - 1) * 100;
  return 0;
}

/* ── Dividend gap detection ── */
// DIV_EXDATES is a global map { ticker: Set<date-string> }, set by caller
let DIV_EXDATES = {};

function isKnownExDate(ticker, dateStr) {
  const s = DIV_EXDATES[ticker];
  return s ? s.has(dateStr) : false;
}

function isDivGap(data, i, cfg, ticker) {
  if (i < 1) return false;
  if (ticker && DIV_EXDATES[ticker]) return isKnownExDate(ticker, data[i].d);
  const dr = dayRet(data, i);
  if (dr > -cfg.divGap) return false;
  const av = avgVol(data, i, cfg.volWin);
  if (!av) return false;
  const vr = data[i].v / av;
  if (vr >= 2.0) return false;
  if (data[i].o >= data[i-1].c * ((100 - cfg.divGap) / 100)) return false;
  return true;
}

function isDivGapBar(bar, tickerPriceMap, date, ticker) {
  if (ticker && DIV_EXDATES[ticker]) return isKnownExDate(ticker, date);
  if (!tickerPriceMap) return false;
  const prevDates = Object.keys(tickerPriceMap).filter(d => d < date).sort();
  if (!prevDates.length) return false;
  const prev = tickerPriceMap[prevDates[prevDates.length - 1]];
  if (!prev || prev.c <= 0) return false;
  const dr = (bar.c / prev.c - 1) * 100;
  if (dr > -3) return false;
  if (bar.o >= prev.c * 0.97) return false;
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   SIGNAL DETECTION
   ═══════════════════════════════════════════════════════════════════════ */
function getTier(vr, cfg) {
  for (const t of cfg.tiers) { if (vr >= t.minVr) return t; }
  return null;
}

function simTradeExit(data, entryIdx, ep, catStopPx, tier, cfg, ticker) {
  let peak = ep;
  for (let j = entryIdx + 1; j < data.length; j++) {
    const held = j - entryIdx;
    if (!isDivGap(data, j, cfg, ticker)) {
      if (data[j].l <= catStopPx) return j;
      if (held >= tier.tsAfter) {
        const tsPx = peak * (1 - tier.tsDist / 100);
        if (data[j].l <= tsPx) return j;
      }
    }
    if (data[j].h > peak) peak = data[j].h;
    if (held >= tier.maxHold) return j;
  }
  return data.length - 1;
}

function scanSignals(ticker, data, cfg) {
  const signals = [];
  const costIn = getCostIn(cfg);
  let consec = 0;
  let i = 0;

  while (i < data.length - 1) {
    if (isDivGap(data, i, cfg, ticker)) { consec = 0; i++; continue; }
    const av = avgVol(data, i, cfg.volWin);
    if (!av) { consec = 0; i++; continue; }
    const vr = data[i].v / av;
    if (vr >= cfg.volMin) consec++; else consec = 0;
    if (consec < cfg.sigDays) { i++; continue; }
    if (cfg.maxVr < 999 && vr > cfg.maxVr) { i++; continue; }
    const tier = getTier(vr, cfg);
    if (!tier) { i++; continue; }
    const atr = atrPct(data, i, cfg.atrWin);
    if (atr < cfg.atrMin) { i++; continue; }
    const ma = maVal(data, i, cfg.maPeriod);
    if (ma === null) { i++; continue; }
    if (cfg.maFilter === 'above' && data[i].c <= ma) { i++; continue; }
    if (cfg.bullBar && data[i].c <= data[i].o) { i++; continue; }
    const cp = closePos(data[i]);
    if (cp < cfg.cpMin) { i++; continue; }
    const dr = dayRet(data, i);
    if (dr > cfg.maxDayRet) { i++; continue; }
    const ei = i + 1;
    if (ei >= data.length) { i++; continue; }
    if (cfg.gapCancel > 0) {
      const cancelPx = data[i].c * (1 + cfg.gapCancel / 100);
      if (data[ei].o > cancelPx) { i++; continue; }
    }
    const avE = avgVol(data, ei, cfg.volWin);
    if (!avE) { i++; continue; }
    const vrE = data[ei].v / avE;
    if (vrE < cfg.vrConfirm) { i++; continue; }
    const rawEP = data[ei].c > 0 ? data[ei].c : data[ei].o;
    const ep = rawEP * (1 + costIn);
    const catStopPx = ep * (1 - cfg.stopPct / 100);
    const liqAvg = avgValueRub(data, i);
    const isLiq = liqAvg >= cfg.liq;

    signals.push({
      ticker, signalIdx: i, entryIdx: ei,
      signalDate: data[i].d, entryDate: data[ei].d,
      vr, vrEntry: vrE, tier, atr20: atr,
      ep, catStopPx, liqAvg, isLiquid: isLiq,
      cp, dayRetPct: dr,
    });

    const exitIdx = simTradeExit(data, ei, ep, catStopPx, tier, cfg, ticker);
    consec = 0;
    i = exitIdx;
  }
  return signals;
}

/* ═══════════════════════════════════════════════════════════════════════
   PORTFOLIO SIMULATION
   ═══════════════════════════════════════════════════════════════════════ */
function buildPriceMap(tickerData) {
  const map = {};
  for (const [tk, bars] of Object.entries(tickerData)) {
    map[tk] = {};
    for (const b of bars) map[tk][b.d] = b;
  }
  return map;
}

function buildDateList(tickerData, startDate) {
  const dset = new Set();
  for (const bars of Object.values(tickerData)) {
    for (const b of bars) if (b.d >= startDate) dset.add(b.d);
  }
  return [...dset].sort();
}

function simulateStrategy(signals, priceMap, dates, maxPos, cfg, stratName) {
  const costOut = getCostOut(cfg);
  const rebalFrac = cfg.rebal === 'half' ? 0.5 : cfg.rebal === 'quarter' ? 0.25 : 0;

  const sigByDate = {};
  for (const s of signals) {
    if (!sigByDate[s.entryDate]) sigByDate[s.entryDate] = [];
    sigByDate[s.entryDate].push(s);
  }
  for (const d of Object.keys(sigByDate)) {
    sigByDate[d].sort((a, b) => b.vr - a.vr || a.ticker.localeCompare(b.ticker));
  }

  let cash = 1.0;
  const positions = [];
  const trades = [];
  const equity = [];

  for (const d of dates) {
    // --- Exits ---
    const toClose = [];
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const bar = priceMap[pos.ticker]?.[d];
      if (!bar) { pos.lastPx = pos.lastPx || pos.ep; continue; }
      pos.lastPx = bar.c;
      pos.held++;

      let exitPrice = null, reason = null;
      const divGapDay = bar.l > 0 && pos.held > 0 && isDivGapBar(bar, priceMap[pos.ticker], d, pos.ticker);

      if (!divGapDay) {
        if (bar.l <= pos.catStopPx) { exitPrice = pos.catStopPx; reason = 'cat_stop'; }
        if (!exitPrice && pos.held >= pos.tier.tsAfter) {
          const tsPx = pos.peak * (1 - pos.tier.tsDist / 100);
          if (bar.l <= tsPx) { exitPrice = tsPx; reason = 'ts_extend'; }
        }
      }
      if (bar.h > pos.peak) pos.peak = bar.h;
      if (!exitPrice && pos.held >= pos.tier.maxHold) { exitPrice = bar.c; reason = 'max_hold'; }

      if (exitPrice !== null) {
        const fe = exitPrice * (1 - costOut);
        const ret = (fe / pos.ep - 1) * 100;
        cash += pos.qty * fe;
        trades.push({
          ticker: pos.ticker, tier: pos.tier.name, vr: pos.vr, atr20: pos.atr20,
          strategy: stratName, signalDate: pos.signalDate, entryDate: pos.entryDate,
          exitDate: d, ep: pos.ep, exitPrice: fe, ret, reason, held: pos.held, liqAvg: pos.liqAvg,
        });
        toClose.push(p);
      }
    }
    for (const idx of toClose.sort((a, b) => b - a)) positions.splice(idx, 1);

    // --- Entries ---
    const daySigs = sigByDate[d];
    if (daySigs && daySigs.length) {
      const candidates = [...daySigs];

      // Rebalancing
      if (rebalFrac > 0 && positions.length === 1 && candidates.length > 0) {
        const ex = positions[0];
        const bar = priceMap[ex.ticker]?.[d];
        if (bar) {
          const markPx = bar.c * (1 - costOut);
          const sellQty = ex.qty * rebalFrac;
          cash += sellQty * markPx;
          const partRet = (markPx / ex.ep - 1) * 100;
          trades.push({
            ticker: ex.ticker, tier: ex.tier.name, vr: ex.vr, atr20: ex.atr20,
            strategy: stratName, signalDate: ex.signalDate, entryDate: ex.entryDate,
            exitDate: d, ep: ex.ep, exitPrice: markPx, ret: partRet, reason: 'rebalance_half',
            held: ex.held, liqAvg: ex.liqAvg,
          });
          ex.qty *= (1 - rebalFrac);
        }
      }

      // ATR rotation
      while (positions.length >= maxPos && candidates.length > 0) {
        candidates.sort((a, b) => b.atr20 - a.atr20 || b.vr - a.vr);
        const cand = candidates[0];
        let weakIdx = -1, weakATR = Infinity;
        for (let p = 0; p < positions.length; p++) {
          const pa = positions[p].currentATR || positions[p].atr20;
          if (pa < weakATR) { weakATR = pa; weakIdx = p; }
        }
        if (weakIdx >= 0 && cand.atr20 >= weakATR * cfg.rotMult && cand.atr20 - weakATR >= cfg.rotAbs) {
          const weak = positions[weakIdx];
          const bar = priceMap[weak.ticker]?.[d];
          const px = bar ? bar.c : weak.lastPx || weak.ep;
          const fe = px * (1 - costOut);
          const ret = (fe / weak.ep - 1) * 100;
          cash += weak.qty * fe;
          trades.push({
            ticker: weak.ticker, tier: weak.tier.name, vr: weak.vr, atr20: weak.atr20,
            strategy: stratName, signalDate: weak.signalDate, entryDate: weak.entryDate,
            exitDate: d, ep: weak.ep, exitPrice: fe, ret, reason: 'rotate_atr20',
            held: weak.held, liqAvg: weak.liqAvg,
          });
          positions.splice(weakIdx, 1);
        } else break;
      }

      // Enter
      if (positions.length < maxPos && candidates.length > 0) {
        const slotsAvail = maxPos - positions.length;
        const toEnter = candidates.slice(0, slotsAvail);
        const budget = cash;
        if (budget > 0 && toEnter.length > 0) {
          const weights = toEnter.map(s => Math.min(s.vr / 3, 3));
          const wSum = weights.reduce((a, b) => a + b, 0);
          for (let k = 0; k < toEnter.length; k++) {
            const s = toEnter[k];
            const stake = budget * (weights[k] / wSum);
            const qty = stake / s.ep;
            if (qty <= 0) continue;
            cash -= qty * s.ep;
            positions.push({
              ticker: s.ticker, ep: s.ep, catStopPx: s.catStopPx,
              tier: s.tier, vr: s.vr, atr20: s.atr20,
              peak: s.ep, held: 0, qty,
              signalDate: s.signalDate, entryDate: s.entryDate,
              liqAvg: s.liqAvg, lastPx: s.ep, currentATR: s.atr20,
            });
          }
        }
      }
    }

    // --- Equity ---
    let openVal = 0;
    for (const pos of positions) {
      const bar = priceMap[pos.ticker]?.[d];
      const px = bar ? bar.c : pos.lastPx || pos.ep;
      pos.lastPx = px;
      openVal += pos.qty * px;
    }
    equity.push({ d, eq: (cash + openVal) * 100 });
  }

  // Close remaining
  const lastDate = dates[dates.length - 1];
  for (const pos of positions) {
    const px = pos.lastPx || pos.ep;
    const fe = px * (1 - getCostOut(cfg));
    const ret = (fe / pos.ep - 1) * 100;
    trades.push({
      ticker: pos.ticker, tier: pos.tier.name, vr: pos.vr, atr20: pos.atr20,
      strategy: stratName, signalDate: pos.signalDate, entryDate: pos.entryDate,
      exitDate: lastDate, ep: pos.ep, exitPrice: fe, ret, reason: 'end_of_data',
      held: pos.held, liqAvg: pos.liqAvg,
    });
  }
  return { trades, equity };
}

/* ═══════════════════════════════════════════════════════════════════════
   STATISTICS
   ═══════════════════════════════════════════════════════════════════════ */
function computeStats(trades) {
  if (!trades.length) return null;
  const rets = trades.map(t => t.ret);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
  const n = rets.length;
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sorted = [...rets].sort((a, b) => a - b);
  const med = sorted[Math.floor(n / 2)];
  const wr = wins.length / n * 100;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const maxWin = Math.max(...rets), maxLoss = Math.min(...rets);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const r of rets) {
    if (r > 0) { cw++; cl = 0; if (cw > maxCW) maxCW = cw; }
    else { cl++; cw = 0; if (cl > maxCL) maxCL = cl; }
  }
  const avgHold = trades.reduce((a, t) => a + t.held, 0) / n;
  const std = Math.sqrt(rets.reduce((a, r) => a + (r - avg) ** 2, 0) / n);
  const sharpe = std > 0 ? Math.max(-99, Math.min(99, (avg / std) * Math.sqrt(252 / Math.max(1, avgHold)))) : 0;
  return { n, avg, med, wr, pf, maxWin, maxLoss, avgWin, avgLoss, maxCW, maxCL, avgHold, sharpe };
}

function computeMaxDD(equity) {
  let peak = -Infinity, maxDD = 0;
  for (const { eq } of equity) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function oosAnalysis(trades, cfg) {
  const oosDate = `${cfg.oosYear}-01-01`;
  const isTrades = trades.filter(t => t.entryDate < oosDate);
  const oosTrades = trades.filter(t => t.entryDate >= oosDate);
  const isS = computeStats(isTrades), oosS = computeStats(oosTrades);
  let verdict = 'INSUFFICIENT';
  if (oosS && oosS.n >= 10 && isS) {
    verdict = (oosS.wr >= isS.wr * 0.85 && oosS.avg >= isS.avg * 0.50) ? 'CONFIRMED' : 'DEGRADING';
  }
  return { is: isS, oos: oosS, verdict, isN: isTrades.length, oosN: oosTrades.length };
}

/* ═══════════════════════════════════════════════════════════════════════
   FULL BACKTEST RUN — single config, returns summary object
   ═══════════════════════════════════════════════════════════════════════ */
function runBacktestEngine(cfg, tickerData, priceMap, dates) {
  const startDate = `${cfg.startYear}-01-01`;
  const filteredDates = dates.filter(d => d >= startDate);

  // Scan signals
  const allSignals = [];
  for (const tk of Object.keys(tickerData)) {
    const sigs = scanSignals(tk, tickerData[tk], cfg);
    for (const s of sigs) if (s.entryDate >= startDate) allSignals.push(s);
  }
  allSignals.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.vr - a.vr || a.ticker.localeCompare(b.ticker));

  const s1Sigs = allSignals.filter(s => s.isLiquid);
  const s2Sigs = allSignals.filter(s => !s.isLiquid);

  const s1 = simulateStrategy(s1Sigs, priceMap, filteredDates, cfg.maxPos1, cfg, 'S1');
  const s2 = simulateStrategy(s2Sigs, priceMap, filteredDates, cfg.maxPos2, cfg, 'S2');

  // Combined equity
  const combined = [];
  for (let i = 0; i < filteredDates.length; i++) {
    const e1 = s1.equity[i]?.eq || 100, e2 = s2.equity[i]?.eq || 100;
    combined.push({ d: filteredDates[i], eq: (e1 + e2) / 2 });
  }

  const allTrades = [...s1.trades, ...s2.trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const stats = computeStats(allTrades);
  if (!stats) return null;

  const maxDD = computeMaxDD(combined);
  const totalReturn = combined.length ? (combined[combined.length - 1].eq / combined[0].eq - 1) * 100 : 0;
  const years = combined.length > 1
    ? (new Date(combined[combined.length - 1].d) - new Date(combined[0].d)) / (365.25 * 24 * 60 * 60 * 1000) : 1;
  const cagr = years > 0 ? ((combined[combined.length - 1].eq / combined[0].eq) ** (1 / years) - 1) * 100 : 0;
  const oos = oosAnalysis(allTrades, cfg);

  return {
    cfg, stats, maxDD, totalReturn, cagr, oos,
    trades: allTrades, equity: combined,
    s1equity: s1.equity, s2equity: s2.equity,
  };
}
