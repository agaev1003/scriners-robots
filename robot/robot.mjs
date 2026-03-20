// robot.mjs — Main cycle orchestrator (single-run, called by cron/PM2)
// Spec: TRADING_SYSTEM_SPEC.txt, Part 12.8
//
// Imports all modules, runs one cycle: reconcile → manage → entry → save.
// Web panel runs separately via panel.js (or inline if PORT is set).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as tkf from './tinkoff.js';
import { P, BLACKLIST, scanTicker, isDivGap } from './signals.js';
import { loadState, saveState, markProcessed, isProcessed, primeIfNeeded, recordTrade, recordCurvePoint } from './state.js';
import { updatePositionFromCandles, checkExit, allocByVr, findAtrRotation, executeBuy, executeSell, placeStop, cancelStop } from './portfolio.js';
import { reconcile } from './reconcile.js';
import { startPanel } from './panel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ═══ CONFIG (from env) ═══ */
const TOKEN   = process.env.TKF_TOKEN;
const ACCOUNT = process.env.TKF_ACCOUNT_ID;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PORT    = parseInt(process.env.PORT || '0', 10);

const MIN_BARS  = 150;
const PARALLEL  = 10;
const ISS       = 'https://iss.moex.com/iss';
const LOG_FILE  = join(__dirname, 'robot.log');

// Entry windows MSK (minutes from midnight): 07-08, 10-14
const ENTRY_WINDOWS = [[420, 480], [600, 840]];

/* ═══ LOGGING ═══ */
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

/* ═══ TIME HELPERS ═══ */
export function mskNow() {
  const now = new Date();
  return new Date(now.getTime() + 3 * 3600_000 + now.getTimezoneOffset() * 60_000);
}

export function todayMSK() { return mskNow().toISOString().slice(0, 10); }

function isEntryWindow() {
  const m = mskNow();
  const dow = m.getDay();
  if (dow === 0 || dow === 6) return false;
  const mins = m.getHours() * 60 + m.getMinutes();
  return ENTRY_WINDOWS.some(([a, b]) => mins >= a && mins < b);
}

/* ═══ SEMAPHORE ═══ */
function makeSem(max) {
  let running = 0;
  const queue = [];
  return fn => new Promise((res, rej) => {
    const go = () => {
      running++;
      fn().then(res, rej).finally(() => { running--; if (queue.length) queue.shift()(); });
    };
    running < max ? go() : queue.push(go);
  });
}
const sem = makeSem(PARALLEL);

/* ═══ MOEX ISS DATA LOADING ═══ */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ISS ${r.status}`);
  return r.json();
}

async function loadTickersMoex() {
  const url = `${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json` +
    `?iss.meta=off&iss.only=securities&securities.columns=SECID,SHORTNAME,LISTLEVEL`;
  const j = await fetchJSON(url);
  return j.securities.data
    .filter(r => r[2] >= 1 && r[2] <= 3 && !BLACKLIST.includes(r[0]))
    .map(r => ({ secid: r[0], name: r[1] }));
}

async function loadCandlesMoex(ticker) {
  const from = new Date();
  from.setDate(from.getDate() - 800);
  const fromStr = from.toISOString().slice(0, 10);
  const bars = [];
  let start = 0;
  while (true) {
    const url = `${ISS}/engines/stock/markets/shares/boards/TQBR/securities/${ticker}` +
      `/candles.json?interval=24&from=${fromStr}&iss.meta=off&iss.only=candles` +
      `&candles.columns=begin,open,close,high,low,volume&start=${start}`;
    const j = await fetchJSON(url);
    const rows = j.candles.data;
    if (!rows || !rows.length) break;
    for (const r of rows)
      bars.push({ d: r[0].slice(0, 10), o: r[1], c: r[2], h: r[3], l: r[4], v: r[5] });
    if (rows.length < 500) break;
    start += 500;
  }
  return bars;
}

async function loadDivsMoex(ticker) {
  try {
    const j = await fetchJSON(`${ISS}/securities/${ticker}/dividends.json?iss.meta=off`);
    return (j.dividends.data || []).map(r => r[3]).filter(Boolean);
  } catch { return []; }
}

async function loadAllData(tickers) {
  const candleMap = {}, divMap = {};
  let done = 0;
  await Promise.all(tickers.map(t => sem(async () => {
    try {
      const [candles, divs] = await Promise.all([loadCandlesMoex(t.secid), loadDivsMoex(t.secid)]);
      if (candles.length >= MIN_BARS) { candleMap[t.secid] = candles; divMap[t.secid] = divs; }
    } catch (e) { log(`WARN: ${t.secid} load: ${e.message}`); }
    if (++done % 50 === 0) log(`Data: ${done}/${tickers.length}`);
  })));
  return { candleMap, divMap };
}

/* ═══ TINKOFF INSTRUMENT MAP ═══ */
async function loadInstruments() {
  const shares = await tkf.getShares(TOKEN);
  const map = {};
  for (const s of shares) map[s.ticker] = { uid: s.uid, lot: s.lot, figi: s.figi, name: s.name };
  return map;
}

/* ═══ SIGNAL SCANNING ═══ */
function scanAll(candleMap, divMap) {
  const sigs = [];
  for (const [ticker, candles] of Object.entries(candleMap)) {
    for (const s of scanTicker(candles, divMap[ticker] || [], 10)) {
      s.secid = ticker;
      sigs.push(s);
    }
  }
  return sigs;
}

/* ═══ MANAGE POSITIONS ═══ */
async function managePositions(state, candleMap, divMap, instrMap) {
  for (const pos of state.positions) {
    if (pos.status !== 'open') continue;
    const candles = candleMap[pos.ticker];
    if (!candles) continue;

    const { held, peak, divGapToday } = updatePositionFromCandles(pos, candles, divMap[pos.ticker] || []);
    pos.held = held;
    pos.peak = peak;

    const lastBar = candles[candles.length - 1];

    // Manual close from panel
    if (pos.manualClose) {
      log(`EXIT ${pos.ticker}: manual_close`);
      await doExit(pos, lastBar.c, 'manual_close', state, instrMap);
      continue;
    }

    // Max hold exit
    if (held >= pos.tier.maxHold) {
      log(`EXIT ${pos.ticker}: max_hold (${held}d)`);
      await doExit(pos, lastBar.c, 'max_hold', state, instrMap);
      continue;
    }

    // Recover missing stop-loss order (e.g. placeStop failed on entry)
    if (!pos.stopOrderId && instrMap[pos.ticker]?.uid) {
      log(`WARN ${pos.ticker}: no stop order — placing recovery stop @ ${pos.catStopPx.toFixed(2)}`);
      try {
        const id = await placeStop(TOKEN, ACCOUNT, instrMap[pos.ticker].uid, pos.lots, pos.catStopPx, DRY_RUN, log);
        pos.stopOrderId = id;
        pos.currentStopPx = pos.catStopPx;
      } catch (e) { log(`WARN ${pos.ticker}: recovery stop failed: ${e.message}`); }
    }

    // Trailing stop update (broker-side order)
    if (!divGapToday && held >= pos.tier.tsAfter) {
      const tsPx = peak * (1 - pos.tier.tsDist / 100);
      const newStop = Math.max(tsPx, pos.catStopPx);
      if (newStop > (pos.currentStopPx || 0) + 0.01) {
        log(`STOP ${pos.ticker}: ${(pos.currentStopPx || 0).toFixed(2)} → ${newStop.toFixed(2)}`);
        if (pos.stopOrderId) await cancelStop(TOKEN, ACCOUNT, pos.stopOrderId, DRY_RUN, log);
        try {
          const id = await placeStop(TOKEN, ACCOUNT, instrMap[pos.ticker]?.uid, pos.lots, newStop, DRY_RUN, log);
          pos.stopOrderId = id;
          pos.currentStopPx = newStop;
        } catch (e) { log(`WARN ${pos.ticker}: stop update failed: ${e.message}`); }
      }
    }
    if (divGapToday) log(`DIV_GAP ${pos.ticker}: skip stop checks`);
  }
}

async function doExit(pos, price, reason, state, instrMap) {
  const uid = instrMap[pos.ticker]?.uid;
  if (pos.stopOrderId) await cancelStop(TOKEN, ACCOUNT, pos.stopOrderId, DRY_RUN, log);
  if (uid) await executeSell(TOKEN, ACCOUNT, uid, pos.lots, DRY_RUN, log);

  const trade = recordTrade(state, pos, price, todayMSK(), reason);
  pos.status = 'closed';
  log(`EXIT ${pos.ticker}: ${reason} ret=${trade.ret.toFixed(2)}%`);
}

/* ═══ ENTRY LOGIC ═══ */
async function doEntries(state, candleMap, divMap, instrMap) {
  const allSigs = scanAll(candleMap, divMap);

  // Filter: confirmed, not processed, dedup by ticker
  const byTicker = {};
  for (const s of allSigs) {
    if (isProcessed(state, s.secid, s.date)) continue;
    if (s.t1Status !== 'confirmed') continue;
    if (!byTicker[s.secid] || s.date > byTicker[s.secid].date) byTicker[s.secid] = s;
  }
  const candidates = Object.values(byTicker);
  if (!candidates.length) return;
  log(`Candidates: ${candidates.map(s => `${s.secid}(VR=${s.vr.toFixed(1)})`).join(', ')}`);

  // First-run priming
  if (primeIfNeeded(state, candidates)) {
    log('First run: primed signals, no entry');
    return;
  }

  // Split budget evenly between strategies (each gets 50% of current cash)
  const budgetPerStrategy = state.cashRub * 0.5;

  for (const strat of ['S1', 'S2']) {
    const cands = candidates.filter(s => s.strategy === strat);
    if (!cands.length) continue;
    const maxPos = strat === 'S1' ? P.maxPos1 : P.maxPos2;
    const openPos = state.positions.filter(p => p.status === 'open' && p.strategy === strat);

    // ATR rotation
    if (openPos.length >= maxPos) {
      cands.sort((a, b) => b.atr - a.atr || b.vr - a.vr);
      const weak = findAtrRotation(cands[0], openPos);
      if (weak) {
        const px = candleMap[weak.ticker]?.at(-1)?.c || weak.entryPrice;
        log(`ROTATE ${weak.ticker}→${cands[0].secid}`);
        await doExit(weak, px, 'rotate_atr', state, instrMap);
      }
    }

    const slots = maxPos - state.positions.filter(p => p.status === 'open' && p.strategy === strat).length;
    if (slots <= 0) continue;

    cands.sort((a, b) => b.vr - a.vr);
    const toEnter = cands.slice(0, slots);
    const budget = Math.min(budgetPerStrategy, state.cashRub);
    const sized = allocByVr(toEnter, budget, instrMap);

    for (const s of sized) {
      const uid = instrMap[s.secid]?.uid;
      if (!uid) { log(`WARN: no uid ${s.secid}`); continue; }

      // Live price
      const prices = await tkf.getLastPrices(TOKEN, [uid]);
      const px = prices[uid];
      if (!px) { log(`WARN: no price ${s.secid}`); continue; }

      const lotSize = instrMap[s.secid]?.lot || 1;
      const lots = Math.max(1, Math.floor(s.stake / (px * lotSize)));
      log(`BUY ${s.secid}: VR=${s.vr.toFixed(1)} ${s.tier.name} ${lots}lots @${px.toFixed(2)}`);

      const result = await executeBuy(TOKEN, ACCOUNT, uid, lots, DRY_RUN, log);
      if (result.filled) {
        // Use actual execution price if available, fall back to last price
        const fillPx = result.executedPrice || px;
        if (result.executedPrice) log(`FILL ${s.secid}: exec @${fillPx.toFixed(2)} (last was ${px.toFixed(2)})`);
        const catStopPx = fillPx * (1 - P.stopPct / 100);
        let stopId = null;
        try { stopId = await placeStop(TOKEN, ACCOUNT, uid, result.lots, catStopPx, DRY_RUN, log); }
        catch (e) { log(`WARN: stop ${s.secid}: ${e.message}`); }

        state.positions.push({
          ticker: s.secid, uid, strategy: s.strategy, tier: s.tier,
          vr: s.vr, atr20: s.atr, signalDate: s.date, entryDate: todayMSK(),
          entryPrice: fillPx, catStopPx, lots: result.lots, lotSize, peak: fillPx, held: 0,
          stopOrderId: stopId, currentStopPx: catStopPx, status: 'open',
        });
      }
      markProcessed(state, s.secid, s.date);
    }
  }
}

/* ═══ ACCOUNT CURVE ═══ */
async function updateCurve(state, instrMap) {
  if (!ACCOUNT) return;
  try {
    const uids = state.positions.filter(p => p.status === 'open').map(p => instrMap[p.ticker]?.uid).filter(Boolean);
    let openVal = 0;
    if (uids.length) {
      const prices = await tkf.getLastPrices(TOKEN, uids);
      for (const pos of state.positions.filter(p => p.status === 'open')) {
        const px = prices[instrMap[pos.ticker]?.uid] || pos.entryPrice;
        openVal += pos.lots * (pos.lotSize || instrMap[pos.ticker]?.lot || 1) * px;
      }
    }
    recordCurvePoint(state, state.cashRub + openVal, state.cashRub, state.positions.filter(p => p.status === 'open').length);
  } catch (e) { log(`WARN: curve: ${e.message}`); }
}

/* ═══ MAIN CYCLE ═══ */
export async function runCycle() {
  log('═══ Cycle start ═══');
  if (!TOKEN) { log('ERROR: TKF_TOKEN not set'); return; }
  if (!ACCOUNT) log('WARN: TKF_ACCOUNT_ID not set');
  if (DRY_RUN) log('MODE: DRY_RUN');

  const state = loadState();

  let instrMap;
  try {
    instrMap = await loadInstruments();
    log(`Instruments: ${Object.keys(instrMap).length}`);
  } catch (e) { log(`ERROR instruments: ${e.message}`); return; }

  if (ACCOUNT) await reconcile(state, instrMap, TOKEN, ACCOUNT, log, todayMSK());

  let tickers;
  try {
    tickers = await loadTickersMoex();
    log(`Tickers: ${tickers.length}`);
  } catch (e) { log(`ERROR tickers: ${e.message}`); return; }

  const { candleMap, divMap } = await loadAllData(tickers);
  log(`Candles: ${Object.keys(candleMap).length} tickers`);

  await managePositions(state, candleMap, divMap, instrMap);
  state.positions = state.positions.filter(p => p.status === 'open');

  if (isEntryWindow()) {
    await doEntries(state, candleMap, divMap, instrMap);
  } else {
    log('Outside entry window');
  }

  await updateCurve(state, instrMap);

  state.lastRunAt = new Date().toISOString();
  saveState(state);
  const open = state.positions.filter(p => p.status === 'open').length;
  log(`═══ Done ═══ pos=${open} cash=${state.cashRub.toFixed(0)}`);
}

/* ═══ ENTRY POINT ═══ */
process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });

if (PORT) startPanel(PORT, DRY_RUN, log);
runCycle().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
