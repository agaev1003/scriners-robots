// reconcile.js — Broker position reconciliation
// Spec: TRADING_SYSTEM_SPEC.txt, section 12.3

import * as tkf from './tinkoff.js';
import { P } from './signals.js';

/**
 * Reconcile robot state with broker positions.
 *
 * Steps (spec 12.3):
 * 1. Get positions from broker
 * 2. Mark positions gone from broker as closed (broker_gone)
 * 3. Import untracked broker positions (tier=BASE defaults)
 * 4. Update entryPrice from averagePositionPrice (if changed >0.1%)
 * 5. Update cashRub from money balances
 *
 * @param {Object} state - robot state (mutated in place)
 * @param {Object} instrMap - { ticker: { uid, lot, ... } }
 * @param {string} token - Tinkoff API token
 * @param {string} accountId - Tinkoff account ID
 * @param {Function} log - logging function
 * @param {string} today - today's date YYYY-MM-DD
 */
export async function reconcile(state, instrMap, token, accountId, log, today) {
  // 1. Get broker positions
  const posData = await tkf.getPositions(token, accountId);
  const brokerSecs = {};
  for (const s of posData.securities || []) {
    brokerSecs[s.instrumentUid] = {
      balance: parseInt(s.balance || '0', 10),
      blocked: parseInt(s.blocked || '0', 10),
    };
  }

  // Helper: find uid for a ticker
  const uidOf = (ticker) => instrMap[ticker]?.uid;

  // Helper: find ticker by uid
  const tickerOf = (uid) => {
    for (const [t, info] of Object.entries(instrMap)) {
      if (info.uid === uid) return t;
    }
    return null;
  };

  // 2. Mark positions gone from broker
  for (const pos of state.positions) {
    if (pos.status !== 'open') continue;
    const uid = uidOf(pos.ticker);
    if (!uid || !brokerSecs[uid] || brokerSecs[uid].balance <= 0) {
      log(`RECONCILE: ${pos.ticker} gone from broker → closed`);
      pos.status = 'closed';
      pos.exitDate = today;
      pos.exitReason = 'broker_gone';
      pos.ret = 0; // unknown exit price
      state.history.push({ ...pos });
    }
  }
  state.positions = state.positions.filter(p => p.status === 'open');

  // 3. Import untracked broker positions
  const trackedUids = new Set(
    state.positions.map(p => uidOf(p.ticker)).filter(Boolean)
  );
  for (const [uid, info] of Object.entries(brokerSecs)) {
    if (trackedUids.has(uid) || info.balance <= 0) continue;
    const ticker = tickerOf(uid);
    if (!ticker) continue;

    log(`RECONCILE: importing untracked ${ticker} (${info.balance} lots)`);
    let price = 0;
    try {
      const prices = await tkf.getLastPrices(token, [uid]);
      price = prices[uid] || 0;
    } catch {}

    state.positions.push({
      ticker, uid, strategy: 'S1',
      tier: P.tiers[2], // BASE default
      vr: 0, atr20: 0,
      signalDate: today, entryDate: today,
      entryPrice: price,
      catStopPx: price * (1 - P.stopPct / 100),
      lots: info.balance,
      peak: price, held: 0,
      stopOrderId: null, currentStopPx: 0,
      status: 'open',
    });
  }

  // 4. Update entryPrice from portfolio averagePositionPrice
  try {
    const portfolio = await tkf.getPortfolio(token, accountId);
    for (const pp of portfolio.positions || []) {
      const avgPx = tkf.quotToNum(pp.averagePositionPrice);
      if (!avgPx) continue;
      const pos = state.positions.find(p => uidOf(p.ticker) === pp.instrumentUid);
      if (pos && Math.abs(avgPx - pos.entryPrice) / pos.entryPrice > 0.001) {
        log(`RECONCILE: ${pos.ticker} EP ${pos.entryPrice.toFixed(2)} → ${avgPx.toFixed(2)}`);
        pos.entryPrice = avgPx;
        pos.catStopPx = avgPx * (1 - P.stopPct / 100);
      }
    }
  } catch (e) {
    log(`WARN: portfolio fetch failed: ${e.message}`);
  }

  // 5. Update cashRub
  for (const m of posData.money || []) {
    if ((m.currency || '').toLowerCase() === 'rub') {
      state.cashRub = tkf.quotToNum(m);
      break;
    }
  }
}
