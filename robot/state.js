// state.js — State persistence with atomic writes and auto-pruning
// Spec: TRADING_SYSTEM_SPEC.txt, section 12.4

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATE_FILE        = join(__dirname, 'state.json');
const MAX_HISTORY       = 2000;
const MAX_CURVE         = 2500;
const PROCESSED_TTL_MS  = 40 * 86400_000;   // 40 days
const MAX_CAPITAL_RUB   = 50_000;

/* ─── Empty state template ─── */
export function emptyState() {
  return {
    version: 1,
    positions: [],
    processedSignals: {},   // { "TICKER_YYYY-MM-DD": timestampMs }
    history: [],            // closed trades
    accountCurve: [],       // { at, totalRub, cashRub, openCount }
    cashRub: MAX_CAPITAL_RUB,
    livePrimedAt: null,     // ISO string — first-run priming timestamp
    lastRunAt: null,        // ISO string — last cycle timestamp
    entryPlan: null,        // cached entry plan
    entryPlanTs: null,      // entry plan timestamp (ms)
  };
}

/* ─── Load state from disk ─── */
export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return emptyState();
  }
}

/* ─── Save state atomically (tmp + rename) with auto-pruning ─── */
export function saveState(st) {
  // Prune processedSignals older than 40 days
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const k of Object.keys(st.processedSignals)) {
    if (st.processedSignals[k] < cutoff) delete st.processedSignals[k];
  }

  // Cap history and curve
  if (st.history.length > MAX_HISTORY)
    st.history = st.history.slice(-MAX_HISTORY);
  if (st.accountCurve.length > MAX_CURVE)
    st.accountCurve = st.accountCurve.slice(-MAX_CURVE);

  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(st, null, 2));
  renameSync(tmp, STATE_FILE);
}

/* ─── Mark a signal as processed ─── */
export function markProcessed(st, ticker, date) {
  st.processedSignals[`${ticker}_${date}`] = Date.now();
}

/* ─── Check if signal already processed ─── */
export function isProcessed(st, ticker, date) {
  return !!st.processedSignals[`${ticker}_${date}`];
}

/* ─── First-run priming: mark all current signals, prevent stale entry ─── */
export function primeIfNeeded(st, signals) {
  if (st.livePrimedAt) return false;
  for (const s of signals) {
    markProcessed(st, s.secid, s.date);
  }
  st.livePrimedAt = new Date().toISOString();
  return true; // was primed
}

/* ─── Record closed trade to history ─── */
export function recordTrade(st, pos, exitPrice, exitDate, reason) {
  const ret = (exitPrice / pos.entryPrice - 1) * 100;
  const trade = {
    ...pos,
    status: 'closed',
    exitDate,
    exitPrice,
    exitReason: reason,
    ret,
  };
  st.history.push(trade);
  return trade;
}

/* ─── Record equity curve point ─── */
export function recordCurvePoint(st, totalRub, cashRub, openCount) {
  st.accountCurve.push({
    at: new Date().toISOString(),
    totalRub,
    cashRub,
    openCount,
  });
}

/* ─── Entry plan caching (TTL 36h) ─── */
const ENTRY_PLAN_TTL_MS = 36 * 3600_000;

export function getCachedPlan(st, currentSignalDate) {
  if (!st.entryPlan || !st.entryPlanTs) return null;
  if (Date.now() - st.entryPlanTs > ENTRY_PLAN_TTL_MS) return null;
  if (st.entryPlan.signalDate !== currentSignalDate) return null;
  return st.entryPlan;
}

export function setCachedPlan(st, plan) {
  st.entryPlan = plan;
  st.entryPlanTs = Date.now();
}

export function clearCachedPlan(st) {
  st.entryPlan = null;
  st.entryPlanTs = null;
}
