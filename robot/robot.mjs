// robot.mjs — Trading robot main entry point (single-run, called by cron/PM2)
// Spec: TRADING_SYSTEM_SPEC.txt, Parts 12-15

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as tkf from './tinkoff.js';
import {
  P, BLACKLIST, scanTicker, avgVol, atrPct, avgValueRub,
  isDivGap, getTier,
} from './signals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ═══ CONFIG ═══ */
const TOKEN   = process.env.TKF_TOKEN;
const ACCOUNT = process.env.TKF_ACCOUNT_ID;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PORT    = parseInt(process.env.PORT || '0', 10);

const MAX_CAPITAL_RUB   = 50_000;
const MIN_BARS          = 150;
const PROCESSED_TTL_MS  = 40 * 86400_000;
const MAX_HISTORY       = 2000;
const MAX_CURVE         = 2500;
const ENTRY_PLAN_TTL_MS = 36 * 3600_000;
const PARALLEL          = 10;

const STATE_FILE = join(__dirname, 'state.json');
const LOG_FILE   = join(__dirname, 'robot.log');
const ISS        = 'https://iss.moex.com/iss';

// Entry windows MSK (minutes from midnight)
const ENTRY_WINDOWS = [[420, 480], [600, 840]]; // 07-08, 10-14

/* ═══ LOGGING ═══ */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

/* ═══ STATE ═══ */
function emptyState() {
  return {
    version: 1, positions: [], processedSignals: {},
    history: [], accountCurve: [], cashRub: MAX_CAPITAL_RUB,
    livePrimedAt: null, lastRunAt: null,
    entryPlan: null, entryPlanTs: null,
  };
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { return emptyState(); }
}

function saveState(st) {
  // Prune old data
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const k of Object.keys(st.processedSignals)) {
    if (st.processedSignals[k] < cutoff) delete st.processedSignals[k];
  }
  if (st.history.length > MAX_HISTORY)
    st.history = st.history.slice(-MAX_HISTORY);
  if (st.accountCurve.length > MAX_CURVE)
    st.accountCurve = st.accountCurve.slice(-MAX_CURVE);

  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(st, null, 2));
  renameSync(tmp, STATE_FILE);
}

/* ═══ TIME HELPERS ═══ */
function mskNow() {
  const now = new Date();
  return new Date(now.getTime() + 3 * 3600_000 + now.getTimezoneOffset() * 60_000);
}

function todayMSK() { return mskNow().toISOString().slice(0, 10); }

function isEntryWindow() {
  const m = mskNow();
  const dow = m.getDay();
  if (dow === 0 || dow === 6) return false;
  const mins = m.getHours() * 60 + m.getMinutes();
  return ENTRY_WINDOWS.some(([a, b]) => mins >= a && mins < b);
}

function isMarketDay() {
  const dow = mskNow().getDay();
  return dow !== 0 && dow !== 6;
}

/* ═══ SEMAPHORE ═══ */
function makeSem(max) {
  let running = 0;
  const queue = [];
  return function run(fn) {
    return new Promise((res, rej) => {
      const go = () => {
        running++;
        fn().then(res, rej).finally(() => { running--; if (queue.length) queue.shift()(); });
      };
      if (running < max) go(); else queue.push(go);
    });
  };
}
const sem = makeSem(PARALLEL);

/* ═══ MOEX ISS HELPERS ═══ */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ISS ${r.status} ${url}`);
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
    for (const r of rows) bars.push({ d: r[0].slice(0, 10), o: r[1], c: r[2], h: r[3], l: r[4], v: r[5] });
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

/* ═══ INSTRUMENT MAPPING ═══ */
async function loadInstruments() {
  const shares = await tkf.getShares(TOKEN);
  const byTicker = {};
  for (const s of shares) {
    byTicker[s.ticker] = { uid: s.uid, lot: s.lot, figi: s.figi, name: s.name };
  }
  return byTicker;
}

/* ═══ DATA LOADING ═══ */
async function loadAllData(tickers) {
  const candleMap = {};
  const divMap = {};
  let done = 0;
  await Promise.all(tickers.map(t => sem(async () => {
    try {
      const [candles, divs] = await Promise.all([
        loadCandlesMoex(t.secid),
        loadDivsMoex(t.secid),
      ]);
      if (candles.length >= MIN_BARS) {
        candleMap[t.secid] = candles;
        divMap[t.secid] = divs;
      }
    } catch (e) { log(`WARN: ${t.secid} load failed: ${e.message}`); }
    done++;
    if (done % 50 === 0) log(`Loading data: ${done}/${tickers.length}`);
  })));
  return { candleMap, divMap };
}

/* ═══ SIGNAL SCANNING ═══ */
function scanAll(candleMap, divMap) {
  const allSigs = [];
  for (const [ticker, candles] of Object.entries(candleMap)) {
    const sigs = scanTicker(candles, divMap[ticker] || [], 10);
    for (const s of sigs) {
      s.secid = ticker;
      allSigs.push(s);
    }
  }
  return allSigs;
}

/* ═══ RECONCILIATION (spec 12.3) ═══ */
async function reconcile(state, instrMap) {
  if (!ACCOUNT) return;
  try {
    const posData = await tkf.getPositions(TOKEN, ACCOUNT);
    const brokerSecs = {};
    for (const s of posData.securities || []) {
      brokerSecs[s.instrumentUid] = { balance: parseInt(s.balance || '0', 10) };
    }

    // Mark positions gone from broker
    for (const pos of state.positions) {
      if (pos.status !== 'open') continue;
      const uid = instrMap[pos.ticker]?.uid;
      if (!uid || !brokerSecs[uid]) {
        log(`RECONCILE: ${pos.ticker} gone from broker`);
        pos.status = 'closed';
        pos.exitDate = todayMSK();
        pos.exitReason = 'broker_gone';
        state.history.push({ ...pos });
      }
    }
    state.positions = state.positions.filter(p => p.status === 'open');

    // Update cash
    for (const m of posData.money || []) {
      if ((m.currency || '').toLowerCase() === 'rub') {
        state.cashRub = tkf.quotToNum(m);
      }
    }

    // Import untracked broker positions
    const tracked = new Set(state.positions.map(p => instrMap[p.ticker]?.uid));
    for (const [uid, info] of Object.entries(brokerSecs)) {
      if (tracked.has(uid) || info.balance <= 0) continue;
      // Find ticker by uid
      const ticker = Object.entries(instrMap).find(([, v]) => v.uid === uid)?.[0];
      if (!ticker) continue;
      log(`RECONCILE: importing untracked ${ticker} (${info.balance} lots)`);
      const prices = await tkf.getLastPrices(TOKEN, [uid]);
      const price = prices[uid] || 0;
      state.positions.push({
        ticker, uid, strategy: 'S1', tier: P.tiers[2], // BASE default
        vr: 0, atr20: 0, signalDate: todayMSK(), entryDate: todayMSK(),
        entryPrice: price, catStopPx: price * (1 - P.stopPct / 100),
        lots: info.balance, peak: price, held: 0,
        stopOrderId: null, currentStopPx: 0, status: 'open',
      });
    }

    // Update entry prices from portfolio
    try {
      const portfolio = await tkf.getPortfolio(TOKEN, ACCOUNT);
      for (const pp of portfolio.positions || []) {
        const avgPx = tkf.quotToNum(pp.averagePositionPrice);
        if (!avgPx) continue;
        const pos = state.positions.find(p => instrMap[p.ticker]?.uid === pp.instrumentUid);
        if (pos && Math.abs(avgPx - pos.entryPrice) / pos.entryPrice > 0.001) {
          log(`RECONCILE: ${pos.ticker} EP ${pos.entryPrice.toFixed(2)} → ${avgPx.toFixed(2)}`);
          pos.entryPrice = avgPx;
          pos.catStopPx = avgPx * (1 - P.stopPct / 100);
        }
      }
    } catch (e) { log(`WARN: portfolio fetch: ${e.message}`); }
  } catch (e) { log(`ERROR reconcile: ${e.message}`); }
}

/* ═══ POSITION MANAGEMENT (spec 5.1, 12.x) ═══ */
async function managePositions(state, candleMap, divMap, instrMap) {
  const today = todayMSK();
  for (const pos of state.positions) {
    if (pos.status !== 'open') continue;
    const candles = candleMap[pos.ticker];
    if (!candles) continue;

    // Update held & peak from candle data
    const entryIdx = candles.findIndex(b => b.d >= pos.entryDate);
    if (entryIdx < 0) continue;
    const lastIdx = candles.length - 1;
    pos.held = lastIdx - entryIdx;

    // Update peak from bars after entry
    for (let j = entryIdx + 1; j <= lastIdx; j++) {
      if (candles[j].h > pos.peak) pos.peak = candles[j].h;
    }

    const tier = pos.tier;
    const divDates = divMap[pos.ticker] || [];
    const lastBar = candles[lastIdx];
    const divGapToday = isDivGap(candles, lastIdx, divDates);

    // Max hold exit
    if (pos.held >= tier.maxHold) {
      log(`EXIT ${pos.ticker}: max_hold (${pos.held} days)`);
      await executeExit(pos, lastBar.c, 'max_hold', state, instrMap);
      continue;
    }

    // Trailing stop update (broker-side)
    if (!divGapToday && pos.held >= tier.tsAfter) {
      const tsPx = pos.peak * (1 - tier.tsDist / 100);
      const newStop = Math.max(tsPx, pos.catStopPx);
      if (newStop > (pos.currentStopPx || 0) + 0.01) {
        log(`STOP UPDATE ${pos.ticker}: ${(pos.currentStopPx || 0).toFixed(2)} → ${newStop.toFixed(2)}`);
        await updateStopOrder(pos, newStop, instrMap);
      }
    }

    if (divGapToday) log(`DIV_GAP ${pos.ticker}: skipping stop checks`);
  }
}

async function executeExit(pos, price, reason, state, instrMap) {
  const uid = instrMap[pos.ticker]?.uid;
  if (!DRY_RUN && ACCOUNT && uid) {
    try {
      // Cancel existing stop
      if (pos.stopOrderId) {
        await tkf.cancelStopOrder(TOKEN, ACCOUNT, pos.stopOrderId);
      }
      // Market sell
      await tkf.postMarketOrder(TOKEN, {
        instrumentId: uid, quantity: pos.lots,
        direction: 'ORDER_DIRECTION_SELL', accountId: ACCOUNT,
      });
      log(`SOLD ${pos.ticker} ${pos.lots} lots`);
    } catch (e) { log(`ERROR selling ${pos.ticker}: ${e.message}`); return; }
  } else {
    log(`DRY_RUN: would sell ${pos.ticker} ${pos.lots} lots @ ~${price.toFixed(2)}`);
  }

  const ret = (price / pos.entryPrice - 1) * 100;
  pos.status = 'closed';
  pos.exitDate = todayMSK();
  pos.exitPrice = price;
  pos.exitReason = reason;
  pos.ret = ret;
  state.history.push({ ...pos });
  log(`EXIT ${pos.ticker}: ${reason}, ret=${ret.toFixed(2)}%`);
}

async function updateStopOrder(pos, newStopPx, instrMap) {
  const uid = instrMap[pos.ticker]?.uid;
  if (!DRY_RUN && ACCOUNT && uid) {
    try {
      if (pos.stopOrderId) {
        await tkf.cancelStopOrder(TOKEN, ACCOUNT, pos.stopOrderId);
      }
      const res = await tkf.postStopOrder(TOKEN, {
        instrumentId: uid, quantity: pos.lots,
        stopPrice: newStopPx, accountId: ACCOUNT,
      });
      pos.stopOrderId = res.stopOrderId;
    } catch (e) { log(`ERROR stop update ${pos.ticker}: ${e.message}`); return; }
  } else {
    log(`DRY_RUN: would update stop ${pos.ticker} → ${newStopPx.toFixed(2)}`);
  }
  pos.currentStopPx = newStopPx;
}

/* ═══ ENTRY LOGIC (spec 6.3, 12.5, 12.6) ═══ */
async function scanAndEnter(state, candleMap, divMap, instrMap) {
  // Scan all signals
  const allSigs = scanAll(candleMap, divMap);

  // Filter: confirmed, not processed, dedup by ticker (latest)
  const byTicker = {};
  for (const s of allSigs) {
    const key = `${s.secid}_${s.date}`;
    if (state.processedSignals[key]) continue;
    if (s.t1Status !== 'confirmed') continue;
    if (!byTicker[s.secid] || s.date > byTicker[s.secid].date)
      byTicker[s.secid] = s;
  }
  const candidates = Object.values(byTicker);
  if (!candidates.length) return;

  log(`Found ${candidates.length} candidate(s): ${candidates.map(s => s.secid).join(', ')}`);

  // First-run priming: mark signals as processed but don't enter
  if (!state.livePrimedAt) {
    log('First run priming: marking signals as processed, no entry');
    for (const s of candidates) {
      state.processedSignals[`${s.secid}_${s.date}`] = Date.now();
    }
    state.livePrimedAt = new Date().toISOString();
    return;
  }

  // Split by strategy
  for (const strat of ['S1', 'S2']) {
    const stratCands = candidates.filter(s => s.strategy === strat);
    if (!stratCands.length) continue;

    const openCount = state.positions.filter(p => p.status === 'open' && p.strategy === strat).length;
    const maxPos = strat === 'S1' ? P.maxPos1 : P.maxPos2;

    // ATR rotation: try to replace weakest position
    if (openCount >= maxPos && stratCands.length > 0) {
      stratCands.sort((a, b) => b.atr - a.atr || b.vr - a.vr);
      const cand = stratCands[0];
      const openPos = state.positions.filter(p => p.status === 'open' && p.strategy === strat);
      let weakIdx = -1, weakATR = Infinity;
      for (let i = 0; i < openPos.length; i++) {
        if ((openPos[i].atr20 || 0) < weakATR) { weakATR = openPos[i].atr20 || 0; weakIdx = i; }
      }
      if (weakIdx >= 0 && cand.atr >= weakATR * P.rotMult && cand.atr - weakATR >= P.rotAbs) {
        const weak = openPos[weakIdx];
        const lastBar = candleMap[weak.ticker]?.[candleMap[weak.ticker].length - 1];
        const px = lastBar?.c || weak.entryPrice;
        log(`ATR ROTATE: ${weak.ticker} (ATR=${weakATR.toFixed(1)}) → ${cand.secid} (ATR=${cand.atr.toFixed(1)})`);
        await executeExit(weak, px, 'rotate_atr', state, instrMap);
      }
    }

    // Available slots after rotation
    const currentOpen = state.positions.filter(p => p.status === 'open' && p.strategy === strat).length;
    const slots = maxPos - currentOpen;
    if (slots <= 0) continue;

    // Sort by VR desc, take top N
    stratCands.sort((a, b) => b.vr - a.vr);
    const toEnter = stratCands.slice(0, slots);

    // VR-weighted sizing
    const budget = state.cashRub * (strat === 'S1' ? 0.5 : 0.5);
    const weights = toEnter.map(s => Math.min(s.vr / 3, 3));
    const wSum = weights.reduce((a, b) => a + b, 0);

    for (let k = 0; k < toEnter.length; k++) {
      const s = toEnter[k];
      const stake = budget * (weights[k] / wSum);
      const uid = instrMap[s.secid]?.uid;
      const lotSize = instrMap[s.secid]?.lot || 1;
      if (!uid) { log(`WARN: no uid for ${s.secid}`); continue; }

      // Get live price
      const prices = await tkf.getLastPrices(TOKEN, [uid]);
      const livePx = prices[uid];
      if (!livePx) { log(`WARN: no price for ${s.secid}`); continue; }

      const targetLots = Math.max(1, Math.floor(stake / (livePx * lotSize)));
      log(`ENTRY ${s.secid}: VR=${s.vr.toFixed(1)} tier=${s.tier.name} lots=${targetLots} px=${livePx.toFixed(2)}`);

      // Execute with margin retry
      let filled = false;
      const retryLots = tkf.buildRetryLots(targetLots);
      for (const lots of retryLots) {
        if (!DRY_RUN && ACCOUNT) {
          try {
            await tkf.postMarketOrder(TOKEN, {
              instrumentId: uid, quantity: lots,
              direction: 'ORDER_DIRECTION_BUY', accountId: ACCOUNT,
            });
            filled = true;
            log(`BOUGHT ${s.secid} ${lots} lots`);
            // Place cat stop
            const catStopPx = livePx * (1 - P.stopPct / 100);
            let stopOrderId = null;
            try {
              const stopRes = await tkf.postStopOrder(TOKEN, {
                instrumentId: uid, quantity: lots,
                stopPrice: catStopPx, accountId: ACCOUNT,
              });
              stopOrderId = stopRes.stopOrderId;
            } catch (e) { log(`WARN: stop order failed ${s.secid}: ${e.message}`); }

            state.positions.push({
              ticker: s.secid, uid, strategy: s.strategy, tier: s.tier,
              vr: s.vr, atr20: s.atr, signalDate: s.date, entryDate: todayMSK(),
              entryPrice: livePx, catStopPx, lots, peak: livePx, held: 0,
              stopOrderId, currentStopPx: catStopPx, status: 'open',
            });
            break;
          } catch (e) {
            if (tkf.isMarginError(e)) { log(`Margin error ${s.secid} ${lots} lots, retrying...`); continue; }
            log(`ERROR buy ${s.secid}: ${e.message}`);
            break;
          }
        } else {
          log(`DRY_RUN: would buy ${s.secid} ${lots} lots @ ${livePx.toFixed(2)}`);
          state.positions.push({
            ticker: s.secid, uid, strategy: s.strategy, tier: s.tier,
            vr: s.vr, atr20: s.atr, signalDate: s.date, entryDate: todayMSK(),
            entryPrice: livePx, catStopPx: livePx * (1 - P.stopPct / 100),
            lots, peak: livePx, held: 0,
            stopOrderId: null, currentStopPx: 0, status: 'open',
          });
          filled = true;
          break;
        }
      }
      // Mark processed
      state.processedSignals[`${s.secid}_${s.date}`] = Date.now();
    }
  }
}

/* ═══ ACCOUNT CURVE ═══ */
async function updateCurve(state, instrMap) {
  if (!ACCOUNT) return;
  try {
    const uids = state.positions
      .filter(p => p.status === 'open' && instrMap[p.ticker]?.uid)
      .map(p => instrMap[p.ticker].uid);
    let openVal = 0;
    if (uids.length) {
      const prices = await tkf.getLastPrices(TOKEN, uids);
      for (const pos of state.positions) {
        if (pos.status !== 'open') continue;
        const uid = instrMap[pos.ticker]?.uid;
        const px = uid ? (prices[uid] || pos.entryPrice) : pos.entryPrice;
        const lotSize = instrMap[pos.ticker]?.lot || 1;
        openVal += pos.lots * lotSize * px;
      }
    }
    state.accountCurve.push({
      at: new Date().toISOString(),
      totalRub: state.cashRub + openVal,
      cashRub: state.cashRub,
      openCount: state.positions.filter(p => p.status === 'open').length,
    });
  } catch (e) { log(`WARN: curve update: ${e.message}`); }
}

/* ═══ MAIN CYCLE ═══ */
async function runCycle() {
  log('═══ Cycle start ═══');
  if (!TOKEN) { log('ERROR: TKF_TOKEN not set'); return; }
  if (!ACCOUNT) log('WARN: TKF_ACCOUNT_ID not set, trading disabled');
  if (DRY_RUN) log('MODE: DRY_RUN');

  const state = loadState();

  // Load instruments from Tinkoff
  let instrMap;
  try {
    instrMap = await loadInstruments();
    log(`Loaded ${Object.keys(instrMap).length} instruments from Tinkoff`);
  } catch (e) { log(`ERROR loading instruments: ${e.message}`); return; }

  // Reconcile with broker
  await reconcile(state, instrMap);

  // Load candle data from MOEX ISS
  let tickers;
  try {
    tickers = await loadTickersMoex();
    log(`MOEX tickers: ${tickers.length}`);
  } catch (e) { log(`ERROR loading tickers: ${e.message}`); return; }

  const { candleMap, divMap } = await loadAllData(tickers);
  log(`Candle data loaded for ${Object.keys(candleMap).length} tickers`);

  // Manage existing positions (exits, stop updates)
  await managePositions(state, candleMap, divMap, instrMap);
  state.positions = state.positions.filter(p => p.status === 'open');

  // Scan and enter (only in entry windows)
  if (isEntryWindow()) {
    await scanAndEnter(state, candleMap, divMap, instrMap);
  } else {
    log(`Outside entry window, skipping new entries`);
  }

  // Update account curve
  await updateCurve(state, instrMap);

  // Save
  state.lastRunAt = new Date().toISOString();
  saveState(state);
  log(`═══ Cycle complete ═══ positions=${state.positions.filter(p => p.status === 'open').length} cash=${state.cashRub.toFixed(0)}`);
}

/* ═══ WEB PANEL (spec 12.9) ═══ */
function startPanel() {
  if (!PORT) return;
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      const st = loadState();
      if (path === '/api/status') {
        return json(res, {
          mode: DRY_RUN ? 'dry_run' : 'live',
          lastRunAt: st.lastRunAt,
          positionCount: st.positions.filter(p => p.status === 'open').length,
          cashRub: st.cashRub,
        });
      }
      if (path === '/api/positions') return json(res, st.positions.filter(p => p.status === 'open'));
      if (path === '/api/history') return json(res, st.history.slice(-100));
      if (path === '/api/curve') return json(res, st.accountCurve.slice(-500));
      if (path === '/api/config') return json(res, { P, DRY_RUN, MAX_CAPITAL_RUB, ACCOUNT: ACCOUNT ? '***' : '' });
      res.statusCode = 404;
      json(res, { error: 'not found' });
    } catch (e) {
      res.statusCode = 500;
      json(res, { error: e.message });
    }
  });
  srv.listen(PORT, () => log(`Web panel on :${PORT}`));
}

function json(res, data) { res.end(JSON.stringify(data)); }

/* ═══ ENTRY POINT ═══ */
process.on('SIGINT', () => { log('SIGINT received'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(0); });

startPanel();
runCycle().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
