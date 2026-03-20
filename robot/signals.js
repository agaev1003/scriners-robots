// signals.js — Signal detection engine (1:1 port from moex_screener.html)
// All indicator formulas and filters are identical to backtest V6 / screener V3.

/* ─── Strategy Parameters (hardcoded, identical to backtest Config #12) ─── */
export const P = {
  volMin:    3.6,
  maxVr:     10,
  sigDays:   1,
  atrMin:    1.8,
  atrWin:    20,
  maPeriod:  50,
  maFilter:  'above',
  bullBar:   true,
  cpMin:     0.55,
  maxDayRet: 10,
  vrConfirm: 2.0,
  gapCancel: 6,
  volWin:    60,
  liq:       100e6,
  stopPct:   28,
  divGap:    3,
  commission: 0.0005,
  slippage:   0.001,
  rotMult:   1.5,
  rotAbs:    0.5,
  maxPos1:   2,
  maxPos2:   2,
  tiers: [
    { name: 'ULTRA',  minVr: 7.0, maxHold: 15, tsAfter: 6, tsDist: 2.6 },
    { name: 'STRONG', minVr: 6.5, maxHold: 13, tsAfter: 6, tsDist: 1.8 },
    { name: 'BASE',   minVr: 3.6, maxHold: 10, tsAfter: 5, tsDist: 1.4 },
  ],
};

export const BLACKLIST = ['MOEX', 'IRAO', 'FEES'];

/* ─── Indicators (identical to backtest / screener) ─── */

/**
 * Average volume over `win` bars ending before bar `i` (exclusive).
 * Returns null if insufficient history or data quality.
 * @param {Array<{v:number}>} data - OHLCV bars
 * @param {number} i - current bar index
 * @param {number} win - lookback window (default P.volWin=60)
 */
export function avgVol(data, i, win = P.volWin) {
  if (i < win) return null;
  let sum = 0, cnt = 0;
  for (let k = i - win; k < i; k++) {
    if (data[k].v > 0) { sum += data[k].v; cnt++; }
  }
  if (cnt < win * 0.7) return null;
  return sum / cnt;
}

/**
 * Simple moving average of close prices over `period` bars ending at bar `i`.
 */
export function maVal(data, i, period = P.maPeriod) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += data[k].c;
  return sum / period;
}

/**
 * Close position in day range: (close - low) / (high - low).
 * Returns 0.5 if range is zero.
 */
export function closePos(bar) {
  const range = bar.h - bar.l;
  if (range === 0) return 0.5;
  return (bar.c - bar.l) / range;
}

/**
 * ATR% over `win` bars BEFORE bar `i` (excludes current bar).
 * Measures background volatility, not signal-day volatility.
 */
export function atrPct(data, i, win = P.atrWin) {
  if (i < win + 1) return null;
  let sum = 0;
  for (let k = i - win; k < i; k++) {
    const tr = Math.max(
      data[k].h - data[k].l,
      Math.abs(data[k].h - data[k - 1].c),
      Math.abs(data[k].l - data[k - 1].c),
    );
    sum += (tr / data[k].c) * 100;
  }
  return sum / win;
}

/**
 * Average daily turnover in rubles over `win` bars before bar `i`.
 */
export function avgValueRub(data, i, win = 200) {
  if (i < win) return null;
  let sum = 0, cnt = 0;
  for (let k = i - win; k < i; k++) {
    const val = data[k].v * data[k].c;
    if (val > 0) { sum += val; cnt++; }
  }
  return cnt > 0 ? sum / cnt : null;
}

/**
 * Absolute day return in % (always positive).
 */
export function dayRet(data, i) {
  if (i < 1) return 0;
  return Math.abs((data[i].c - data[i - 1].c) / data[i - 1].c) * 100;
}

/* ─── Tier determination ─── */

/**
 * Returns tier object {name, minVr, maxHold, tsAfter, tsDist} or null.
 * Sorted by minVr descending so highest tier matches first (ULTRA > STRONG > BASE).
 */
const _sortedTiers = [...P.tiers].sort((a, b) => b.minVr - a.minVr);
export function getTier(vr) {
  for (const t of _sortedTiers) {
    if (vr >= t.minVr) return t;
  }
  return null;
}

/* ─── Dividend gap detection ─── */

/**
 * Check if bar date matches a known dividend registry close date.
 */
export function isDivGapDate(bar, divDates) {
  return divDates.includes(bar.d);
}

/**
 * Heuristic div gap detection (fallback when no ISS dividend data).
 * All conditions: drop >= 3%, VR < 2, gap down on open.
 */
export function isDivGapHeuristic(data, i) {
  if (i < 1) return false;
  const ret = (data[i].c - data[i - 1].c) / data[i - 1].c * 100;
  if (ret > -P.divGap) return false;
  const av = avgVol(data, i, P.volWin);
  const vr = av ? data[i].v / av : 99;
  if (vr >= 2) return false;
  if (data[i].o >= data[i - 1].c) return false;
  return true;
}

/**
 * Combined div gap check: exact dates first, then heuristic.
 */
export function isDivGap(data, i, divDates = []) {
  if (isDivGapDate(data[i], divDates)) return true;
  return isDivGapHeuristic(data, i);
}

/* ─── Signal Scanner ─── */

/**
 * Scan a single ticker's OHLCV data for signals within the last `scanWindow` bars.
 * Returns array of signal objects.
 *
 * @param {Array<{d:string,o:number,c:number,h:number,l:number,v:number}>} data
 * @param {string[]} divDates - dividend registry close dates (YYYY-MM-DD)
 * @param {number} scanWindow - how many recent bars to scan (default 10)
 * @returns {Array<Object>} signals
 */
export function scanTicker(data, divDates = [], scanWindow = 10) {
  const signals = [];
  const len = data.length;
  const startIdx = Math.max(len - scanWindow, P.volWin + P.maPeriod);

  for (let i = startIdx; i < len; i++) {
    const bar = data[i];

    // 1. Div gap — skip
    if (isDivGap(data, i, divDates)) continue;

    // 2. avgVol
    const av = avgVol(data, i, P.volWin);
    if (!av) continue;

    // 3. VR >= volMin
    const vr = bar.v / av;
    if (vr < P.volMin) continue;

    // 4. Max VR filter
    if (vr > P.maxVr) continue;

    // 5. Consecutive days with VR >= volMin
    let consec = 0;
    for (let k = i; k >= Math.max(0, i - 10); k--) {
      const a2 = avgVol(data, k, P.volWin);
      if (a2 && data[k].v / a2 >= P.volMin) consec++;
      else break;
    }
    if (consec < P.sigDays) continue;

    // 6. ATR% >= atrMin
    const atr = atrPct(data, i, P.atrWin);
    if (!atr || atr < P.atrMin) continue;

    // 7. MA50 exists
    const ma = maVal(data, i, P.maPeriod);
    if (!ma) continue;

    // 8. close > MA50
    if (bar.c <= ma) continue;

    // 9. Bull bar (close > open)
    if (P.bullBar && bar.c <= bar.o) continue;

    // 10. Close position >= cpMin
    const cp = closePos(bar);
    if (cp < P.cpMin) continue;

    // 11. Day return <= maxDayRet
    const dr = dayRet(data, i);
    if (dr > P.maxDayRet) continue;

    // Liquidity & strategy classification
    const avgVal = avgValueRub(data, i, 200);
    const strategy = avgVal && avgVal >= P.liq ? 'S1' : 'S2';

    // Tier
    const tier = getTier(vr);
    if (!tier) continue;

    // T+1 confirmation check
    let t1Status = 'pending';
    let t1Vr = null;
    const gapThreshold = bar.c * (1 + P.gapCancel / 100);

    if (i + 1 < len) {
      const nextBar = data[i + 1];
      // Gap cancel
      if (nextBar.o > gapThreshold) continue;
      // VR confirmation
      const av2 = avgVol(data, i + 1, P.volWin);
      if (av2) {
        t1Vr = nextBar.v / av2;
        if (t1Vr >= P.vrConfirm) {
          t1Status = 'confirmed';
        } else {
          continue; // T+1 exists but VR not confirmed — skip
        }
      }
    }

    // Entry price & catastrophic stop (for backtest/screener display)
    let entryPrice = null;
    let catStop = null;
    if (i + 1 < len) {
      entryPrice = data[i + 1].c * (1 + P.slippage);
      catStop = entryPrice * (1 - P.stopPct / 100);
    }

    signals.push({
      barIdx:       i,
      date:         bar.d,
      vr,
      atr,
      cp,
      dayRet:       dr,
      ma50:         ma,
      tier,
      strategy,
      avgTurnover:  avgVal,
      entryPrice,
      catStop,
      gapThreshold,
      t1Status,
      t1Vr,
      close:        bar.c,
      isLastBar:    i === len - 1,
    });
  }
  return signals;
}

/**
 * Full-year signal scanner for portfolio simulation (identical to screener).
 * Scans ~250 bars back, skips forward past trade exits to avoid overlapping.
 *
 * @param {Array} data - OHLCV bars
 * @param {string[]} divDates - dividend dates
 * @returns {Array<Object>} signals with entry/exit info
 */
export function scanTickerFull(data, divDates = []) {
  const signals = [];
  const len = data.length;
  const oneYearBars = 250;
  const startIdx = Math.max(P.volWin + P.maPeriod, len - oneYearBars);
  let consec = 0;

  for (let i = startIdx; i < len - 1; i++) {
    const bar = data[i];
    if (isDivGap(data, i, divDates)) { consec = 0; continue; }
    const av = avgVol(data, i, P.volWin);
    if (!av) { consec = 0; continue; }
    const vr = bar.v / av;
    if (vr >= P.volMin) consec++; else { consec = 0; continue; }
    if (consec < P.sigDays) continue;
    if (vr > P.maxVr) continue;
    const atr = atrPct(data, i, P.atrWin);
    if (!atr || atr < P.atrMin) continue;
    const ma = maVal(data, i, P.maPeriod);
    if (!ma) continue;
    if (bar.c <= ma) continue;
    if (P.bullBar && bar.c <= bar.o) continue;
    const cp = closePos(bar);
    if (cp < P.cpMin) continue;
    const dr = dayRet(data, i);
    if (dr > P.maxDayRet) continue;
    const tier = getTier(vr);
    if (!tier) continue;
    const avgVal = avgValueRub(data, i, 200);
    const isLiquid = avgVal && avgVal >= P.liq;

    // T+1 checks
    const ei = i + 1;
    if (ei >= len) continue;
    const nextBar = data[ei];
    const gapThreshold = bar.c * (1 + P.gapCancel / 100);
    if (nextBar.o > gapThreshold) continue;
    const avE = avgVol(data, ei, P.volWin);
    if (!avE) continue;
    const vrE = nextBar.v / avE;
    if (vrE < P.vrConfirm) continue;

    const ep = nextBar.c * (1 + P.commission + P.slippage);
    const catStopPx = ep * (1 - P.stopPct / 100);

    signals.push({
      ticker:     null,  // filled by caller
      signalDate: bar.d,
      entryDate:  nextBar.d,
      vr,
      vrEntry:    vrE,
      tier,
      atr20:      atr,
      ep,
      catStopPx,
      liqAvg:     avgVal,
      isLiquid,
      cp,
      dayRetPct:  dr,
    });

    // Skip forward past this trade's exit to avoid overlapping
    let peak = ep;
    for (let j = ei + 1; j < len; j++) {
      const held = j - ei;
      if (!isDivGap(data, j, divDates)) {
        if (data[j].l <= catStopPx) { i = j; break; }
        if (held >= tier.tsAfter) {
          const tsPx = peak * (1 - tier.tsDist / 100);
          if (data[j].l <= tsPx) { i = j; break; }
        }
      }
      if (data[j].h > peak) peak = data[j].h;
      if (held >= tier.maxHold) { i = j; break; }
    }
    consec = 0;
  }
  return signals;
}
