// portfolio.js — Position management, sizing, stops, ATR rotation
// Spec: TRADING_SYSTEM_SPEC.txt, Parts 5-6

import { P, isDivGap, getTier, atrPct, avgValueRub } from './signals.js';
import * as tkf from './tinkoff.js';

/* ═══ TIERS & STOPS ═══ */

/**
 * Calculate current stop price for a position.
 * After tsAfter days, trailing stop replaces cat stop if higher.
 */
export function currentStopPrice(pos) {
  const { tier, catStopPx, peak, held } = pos;
  if (held >= tier.tsAfter) {
    const tsPx = peak * (1 - tier.tsDist / 100);
    return Math.max(tsPx, catStopPx);
  }
  return catStopPx;
}

/* ═══ POSITION MANAGEMENT (spec 5.1) ═══ */

/**
 * Update held count and peak from candle data.
 * Returns { held, peak, divGapToday }
 */
export function updatePositionFromCandles(pos, candles, divDates) {
  const entryIdx = candles.findIndex(b => b.d >= pos.entryDate);
  if (entryIdx < 0) return { held: pos.held, peak: pos.peak, divGapToday: false };

  const lastIdx = candles.length - 1;
  const held = lastIdx - entryIdx;

  // Update peak from bars after entry
  let peak = pos.peak;
  for (let j = entryIdx + 1; j <= lastIdx; j++) {
    if (candles[j].h > peak) peak = candles[j].h;
  }

  const divGapToday = isDivGap(candles, lastIdx, divDates);
  return { held, peak, divGapToday };
}

/**
 * Determine if position should exit. Returns { shouldExit, reason, exitPrice } or null.
 */
export function checkExit(pos, lastBar, divGapToday) {
  const tier = pos.tier;

  // Max hold — always checked
  if (pos.held >= tier.maxHold) {
    return { shouldExit: true, reason: 'max_hold', exitPrice: lastBar.c };
  }

  // Cat stop and trailing stop — skipped on div gap day
  if (!divGapToday) {
    // Cat stop
    if (lastBar.l <= pos.catStopPx) {
      return { shouldExit: true, reason: 'cat_stop', exitPrice: pos.catStopPx };
    }
    // Trailing stop (after tsAfter days)
    if (pos.held >= tier.tsAfter) {
      const tsPx = pos.peak * (1 - tier.tsDist / 100);
      if (lastBar.l <= tsPx) {
        return { shouldExit: true, reason: 'trailing_stop', exitPrice: tsPx };
      }
    }
  }

  return null;
}

/* ═══ VR-WEIGHTED SIZING (spec 6.3) ═══ */

/**
 * Calculate position sizes for candidates given a budget.
 * Returns array of { ...candidate, stake, targetLots }.
 */
export function allocByVr(candidates, budget, instrMap) {
  if (!candidates.length || budget <= 0) return [];
  const weights = candidates.map(s => Math.min(s.vr / 3, 3));
  const wSum = weights.reduce((a, b) => a + b, 0);

  return candidates.map((s, k) => {
    const stake = budget * (weights[k] / wSum);
    const lotSize = instrMap[s.secid]?.lot || 1;
    const approxPrice = s.close || s.entryPrice || 1;
    const targetLots = Math.max(1, Math.floor(stake / (approxPrice * lotSize)));
    return { ...s, stake, targetLots };
  });
}

/* ═══ ATR ROTATION (spec 6.5) ═══ */

/**
 * Check if a candidate should replace the weakest open position.
 * Returns the weak position to close, or null.
 */
export function findAtrRotation(candidate, openPositions) {
  if (!openPositions.length) return null;

  let weakIdx = -1, weakATR = Infinity;
  for (let i = 0; i < openPositions.length; i++) {
    const atr = openPositions[i].atr20 || 0;
    if (atr < weakATR) { weakATR = atr; weakIdx = i; }
  }

  if (weakIdx < 0) return null;
  const candATR = candidate.atr || 0;
  if (candATR >= weakATR * P.rotMult && candATR - weakATR >= P.rotAbs) {
    return openPositions[weakIdx];
  }
  return null;
}

/* ═══ ORDER EXECUTION WITH MARGIN RETRY (spec 12.5) ═══ */

/**
 * Execute a buy order with margin retry.
 * Returns { filled, lots, orderId } or { filled: false }.
 */
export async function executeBuy(token, accountId, instrumentId, targetLots, dryRun, log) {
  if (dryRun) {
    log(`DRY_RUN: would buy ${targetLots} lots`);
    return { filled: true, lots: targetLots, orderId: null, executedPrice: null };
  }

  const retryLots = tkf.buildRetryLots(targetLots);
  for (const lots of retryLots) {
    try {
      const res = await tkf.postMarketOrder(token, {
        instrumentId, quantity: lots,
        direction: 'ORDER_DIRECTION_BUY', accountId,
      });
      // Extract executed price from order response if available
      const execPx = tkf.quotToNum(res.executedOrderPrice) || tkf.quotToNum(res.averagePositionPrice) || null;
      return { filled: true, lots, orderId: res.orderId, executedPrice: execPx };
    } catch (e) {
      if (tkf.isMarginError(e)) {
        log(`Margin error at ${lots} lots, retrying smaller...`);
        continue;
      }
      throw e; // non-margin error — propagate
    }
  }
  return { filled: false, lots: 0, orderId: null, executedPrice: null };
}

/**
 * Execute a sell order (market).
 */
export async function executeSell(token, accountId, instrumentId, lots, dryRun, log) {
  if (dryRun) {
    log(`DRY_RUN: would sell ${lots} lots`);
    return;
  }
  await tkf.postMarketOrder(token, {
    instrumentId, quantity: lots,
    direction: 'ORDER_DIRECTION_SELL', accountId,
  });
}

/**
 * Place or update a stop-loss order on broker side.
 * Returns stopOrderId or null.
 */
export async function placeStop(token, accountId, instrumentId, lots, stopPrice, dryRun, log) {
  if (dryRun) {
    log(`DRY_RUN: would place stop @ ${stopPrice.toFixed(2)}`);
    return null;
  }
  const res = await tkf.postStopOrder(token, {
    instrumentId, quantity: lots,
    stopPrice, accountId,
  });
  return res.stopOrderId;
}

/**
 * Cancel an existing stop order.
 */
export async function cancelStop(token, accountId, stopOrderId, dryRun, log) {
  if (dryRun) {
    log(`DRY_RUN: would cancel stop ${stopOrderId}`);
    return;
  }
  await tkf.cancelStopOrder(token, accountId, stopOrderId);
}
