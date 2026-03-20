// tinkoff.js — Tinkoff Invest REST API wrapper
// Spec reference: TRADING_SYSTEM_SPEC.txt, Part 12

const BASE_URL = 'https://invest-public-api.tinkoff.ru/rest';
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const TKF_CANDLE_CHUNK_DAYS = 365;

// ---------------------------------------------------------------------------
// Price conversion: {units, nano} <-> number
// ---------------------------------------------------------------------------

function quotToNum(q) {
  if (!q) return 0;
  return parseInt(q.units || '0', 10) + parseInt(q.nano || '0', 10) / 1e9;
}

function numToQuot(n) {
  const units = Math.floor(n);
  const nano = Math.round((n - units) * 1e9);
  return { units: String(units), nano };
}

// ---------------------------------------------------------------------------
// Core fetch with retry + timeout (spec: 2 retries, backoff 250ms*(attempt+1))
// ---------------------------------------------------------------------------

async function fetchTkf(endpoint, body, token) {
  const url = `${BASE_URL}/${endpoint}`;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(250 * (attempt + 1));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const json = await res.json();
      if (!res.ok) {
        const msg = json?.message || json?.description || res.statusText;
        const err = new Error(`TKF ${res.status}: ${msg}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// UUID v4 for order IDs
// ---------------------------------------------------------------------------

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// API methods (spec section 12.1)
// ---------------------------------------------------------------------------

/** Get all shares (TQBR equities) */
async function getShares(token) {
  const res = await fetchTkf('tinkoff.public.invest.api.contract.v1.InstrumentsService/Shares', {
    instrumentStatus: 'INSTRUMENT_STATUS_BASE',
    instrumentExchange: 'INSTRUMENT_EXCHANGE_UNSPECIFIED',
  }, token);
  return (res.instruments || []).filter(s => s.apiTradeAvailableFlag);
}

/** Get daily candles for instrument, handles chunking by 365 days */
async function getCandles(token, instrumentId, fromDate, toDate) {
  const bars = [];
  let from = new Date(fromDate);
  const to = new Date(toDate);

  while (from < to) {
    const chunkEnd = new Date(from);
    chunkEnd.setDate(chunkEnd.getDate() + TKF_CANDLE_CHUNK_DAYS);
    const end = chunkEnd < to ? chunkEnd : to;

    const res = await fetchTkf('tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles', {
      instrumentId,
      from: from.toISOString(),
      to: end.toISOString(),
      interval: 'CANDLE_INTERVAL_DAY',
      instrumentIdType: 'INSTRUMENT_ID_TYPE_UID',
    }, token);

    for (const c of res.candles || []) {
      bars.push({
        d: c.time ? c.time.slice(0, 10) : '',
        o: quotToNum(c.open),
        c: quotToNum(c.close),
        h: quotToNum(c.high),
        l: quotToNum(c.low),
        v: parseInt(c.volume || '0', 10),
      });
    }
    from = end;
  }
  return bars;
}

/** Get last prices for array of instrument UIDs */
async function getLastPrices(token, instrumentIds) {
  const res = await fetchTkf('tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices', {
    instrumentId: instrumentIds,
  }, token);
  const map = {};
  for (const lp of res.lastPrices || []) {
    map[lp.instrumentUid] = quotToNum(lp.price);
  }
  return map;
}

/** Place market order */
async function postMarketOrder(token, { instrumentId, quantity, direction, accountId }) {
  return fetchTkf('tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder', {
    instrumentId,
    quantity: String(quantity),
    direction, // ORDER_DIRECTION_BUY / ORDER_DIRECTION_SELL
    accountId,
    orderType: 'ORDER_TYPE_MARKET',
    orderId: uuid(),
  }, token);
}

/** Place stop-loss order (GTC) */
async function postStopOrder(token, { instrumentId, quantity, stopPrice, accountId }) {
  return fetchTkf('tinkoff.public.invest.api.contract.v1.StopOrdersService/PostStopOrder', {
    instrumentId,
    quantity: String(quantity),
    stopPrice: numToQuot(stopPrice),
    price: numToQuot(stopPrice), // for stop-loss, price = stopPrice
    direction: 'STOP_ORDER_DIRECTION_SELL',
    stopOrderType: 'STOP_ORDER_TYPE_STOP_LOSS',
    expirationType: 'STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL',
    accountId,
  }, token);
}

/** Cancel a stop order */
async function cancelStopOrder(token, accountId, stopOrderId) {
  return fetchTkf('tinkoff.public.invest.api.contract.v1.StopOrdersService/CancelStopOrder', {
    accountId,
    stopOrderId,
  }, token);
}

/** Get all active stop orders */
async function getStopOrders(token, accountId) {
  const res = await fetchTkf('tinkoff.public.invest.api.contract.v1.StopOrdersService/GetStopOrders', {
    accountId,
  }, token);
  return res.stopOrders || [];
}

/** Get portfolio (positions with averagePositionPrice) */
async function getPortfolio(token, accountId) {
  return fetchTkf('tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', {
    accountId,
    currency: 'RUB',
  }, token);
}

/** Get positions (money + securities balances) */
async function getPositions(token, accountId) {
  return fetchTkf('tinkoff.public.invest.api.contract.v1.OperationsService/GetPositions', {
    accountId,
  }, token);
}

// ---------------------------------------------------------------------------
// Margin error detection (spec 12.5)
// ---------------------------------------------------------------------------

function isMarginError(err) {
  const msg = (err?.message || '') + ' ' + JSON.stringify(err?.body || '');
  const low = msg.toLowerCase();
  return low.includes('margin') || low.includes('not enough assets');
}

/** Build retry lot sizes: 100% -> 75% -> 50% -> 33% -> 25% -> 10% -> 1 lot */
function buildRetryLots(desired) {
  const factors = [1, 0.75, 0.5, 0.33, 0.25, 0.1];
  const lots = [];
  const seen = new Set();
  for (const f of factors) {
    const n = Math.max(1, Math.round(desired * f));
    if (!seen.has(n)) { lots.push(n); seen.add(n); }
  }
  if (!seen.has(1)) lots.push(1);
  return lots;
}

// ---------------------------------------------------------------------------
// Helper: get accounts (useful for discovering accountId)
// ---------------------------------------------------------------------------

async function getAccounts(token) {
  const res = await fetchTkf('tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {}, token);
  return res.accounts || [];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  quotToNum,
  numToQuot,
  fetchTkf,
  getShares,
  getCandles,
  getLastPrices,
  postMarketOrder,
  postStopOrder,
  cancelStopOrder,
  getStopOrders,
  getPortfolio,
  getPositions,
  getAccounts,
  isMarginError,
  buildRetryLots,
  uuid,
};
