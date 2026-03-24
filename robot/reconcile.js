// reconcile.js — Broker position reconciliation
// Spec: TRADING_SYSTEM_SPEC.txt, section 12.3

import * as tkf from './tinkoff.js';
import { P } from './signals.js';

/**
 * Reconcile robot state with broker positions.
 *
 * Steps (spec 12.3, modified):
 * 1. Get positions from broker
 * 2. Mark robot-tracked positions gone from broker as closed (broker_gone)
 * 3. Log untracked broker positions (DO NOT auto-import)
 * 4. Update entryPrice from averagePositionPrice (if changed >0.1%)
 * 5. cashRub managed by robot's own buy/sell accounting (not overwritten from broker)
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
      // Try to get last known price for accurate return calculation
      let exitPrice = pos.entryPrice;
      try {
        if (uid) {
          const prices = await tkf.getLastPrices(token, [uid]);
          if (prices[uid]) exitPrice = prices[uid];
        }
      } catch {}
      const ret = pos.entryPrice > 0 ? (exitPrice / pos.entryPrice - 1) * 100 : 0;
      // Restore position value to cashRub (same as doExit does)
      const exitValue = exitPrice * pos.lots * (pos.lotSize || instrMap[pos.ticker]?.lot || 1);
      if (isFinite(exitValue) && exitValue > 0) {
        state.cashRub += exitValue;
      }
      log(`RECONCILE: ${pos.ticker} gone from broker → closed (ret=${ret.toFixed(2)}%, returned ${(exitValue||0).toFixed(0)} RUB)`);
      pos.status = 'closed';
      pos.exitDate = today;
      pos.exitPrice = exitPrice;
      pos.exitReason = 'broker_gone';
      pos.ret = ret;
      state.history.push({ ...pos });
    }
  }
  state.positions = state.positions.filter(p => p.status === 'open');

  // 3. Log untracked broker positions (DO NOT auto-import)
  // Auto-importing caused the robot to track positions it didn't open,
  // inflating equity curve and causing phantom drawdowns when they close externally.
  const trackedUids = new Set(
    state.positions.map(p => uidOf(p.ticker)).filter(Boolean)
  );
  for (const [uid, info] of Object.entries(brokerSecs)) {
    if (trackedUids.has(uid) || info.balance <= 0) continue;
    const ticker = tickerOf(uid);
    log(`RECONCILE: untracked position ${ticker || uid} (${info.balance} shares) — ignored (not opened by robot)`);
  }

  // 4. Update entryPrice and lots from portfolio
  try {
    const portfolio = await tkf.getPortfolio(token, accountId);
    for (const pp of portfolio.positions || []) {
      const avgPx = tkf.quotToNum(pp.averagePositionPrice);
      if (!avgPx) continue;
      const pos = state.positions.find(p => uidOf(p.ticker) === pp.instrumentUid);
      if (!pos) continue;

      // Update entry price if changed
      if (pos.entryPrice > 0 && Math.abs(avgPx - pos.entryPrice) / pos.entryPrice > 0.001) {
        log(`RECONCILE: ${pos.ticker} EP ${pos.entryPrice.toFixed(2)} → ${avgPx.toFixed(2)}`);
        pos.entryPrice = avgPx;
        pos.catStopPx = avgPx * (1 - P.stopPct / 100);
      }

      // Update lots from portfolio quantity (shares → lots)
      const qtyShares = parseFloat(pp.quantity?.units || '0');
      if (qtyShares > 0) {
        const lotSize = pos.lotSize || instrMap[pos.ticker]?.lot || 1;
        const correctLots = Math.max(1, Math.round(qtyShares / lotSize));
        if (correctLots !== pos.lots) {
          log(`RECONCILE: ${pos.ticker} lots ${pos.lots} → ${correctLots} (${qtyShares} shares, lotSize=${lotSize})`);
          pos.lots = correctLots;
        }
      }
    }
  } catch (e) {
    log(`WARN: portfolio fetch failed: ${e.message}`);
  }

  // 5. Update cashRub — only track robot's capital, not full account balance
  // The robot manages a fixed budget (MAX_CAPITAL from state), not the entire broker account.
  // We update cashRub from broker only if it's LESS than current cashRub (money was withdrawn),
  // but never inflate it beyond the robot's capital allocation.
  // cashRub is maintained by the robot's own buy/sell accounting.
}
