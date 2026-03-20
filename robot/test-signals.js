// test-signals.js — Unit tests for signals.js
import {
  P, BLACKLIST,
  avgVol, maVal, closePos, atrPct, avgValueRub, dayRet,
  getTier, isDivGapHeuristic, isDivGap,
  scanTicker, scanTickerFull,
} from './signals.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}
function approx(a, b, eps = 0.001) {
  return Math.abs(a - b) < eps;
}

// ─── Helper: generate flat OHLCV data ───
function makeBar(i, { o = 100, c = 101, h = 102, l = 99, v = 1000 } = {}) {
  return { d: `2025-01-${String(i + 1).padStart(2, '0')}`, o, c, h, l, v };
}

function makeBars(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => makeBar(i, overrides));
}

console.log('=== Parameters ===');
assert(P.volMin === 3.6, 'volMin');
assert(P.maxVr === 10, 'maxVr');
assert(P.atrMin === 1.8, 'atrMin');
assert(P.stopPct === 28, 'stopPct');
assert(P.tiers.length === 3, 'tiers count');
assert(BLACKLIST.length === 3, 'blacklist count');
console.log('Parameters OK');

console.log('\n=== avgVol ===');
{
  const data = makeBars(70);
  // At index 60, window is [0..59] = 60 bars
  const av = avgVol(data, 60, 60);
  assert(av === 1000, `avgVol basic: ${av}`);

  // Insufficient history
  assert(avgVol(data, 50, 60) === null, 'avgVol too short');

  // Sparse data (many zero volumes)
  const sparse = makeBars(70, { v: 0 });
  for (let k = 0; k < 30; k++) sparse[k].v = 500; // only 30 out of 60 non-zero
  assert(avgVol(sparse, 60, 60) === null, 'avgVol sparse <70%');
}
console.log('avgVol OK');

console.log('\n=== maVal ===');
{
  const data = makeBars(60, { c: 100 });
  assert(maVal(data, 49, 50) === 100, 'maVal constant');
  assert(maVal(data, 48, 50) === null, 'maVal insufficient');

  // Varying closes
  const data2 = makeBars(55);
  for (let i = 0; i < 55; i++) data2[i].c = i + 1;
  // MA50 at index 49 = avg(1..50) = 25.5
  const ma = maVal(data2, 49, 50);
  assert(approx(ma, 25.5), `maVal varying: ${ma}`);
}
console.log('maVal OK');

console.log('\n=== closePos ===');
{
  assert(closePos({ h: 110, l: 90, c: 100, o: 95 }) === 0.5, 'closePos mid');
  assert(closePos({ h: 110, l: 90, c: 110, o: 95 }) === 1.0, 'closePos top');
  assert(closePos({ h: 110, l: 90, c: 90, o: 95 }) === 0.0, 'closePos bottom');
  assert(closePos({ h: 100, l: 100, c: 100, o: 100 }) === 0.5, 'closePos flat');
}
console.log('closePos OK');

console.log('\n=== atrPct ===');
{
  // Uniform bars: TR = h - l = 3 each, close = 101
  const data = makeBars(30, { o: 100, c: 101, h: 102, l: 99 });
  const atr = atrPct(data, 25, 20);
  // TR each bar = max(102-99, |102-101|, |99-101|) = max(3, 1, 2) = 3
  // atr% = (3 / 101) * 100 ≈ 2.97
  assert(atr !== null && approx(atr, 2.97, 0.01), `atrPct: ${atr}`);
  assert(atrPct(data, 15, 20) === null, 'atrPct insufficient');
}
console.log('atrPct OK');

console.log('\n=== avgValueRub ===');
{
  const data = makeBars(210, { c: 50, v: 2_000_000 });
  const avr = avgValueRub(data, 200, 200);
  // 50 * 2M = 100M per bar
  assert(avr !== null && approx(avr, 100e6), `avgValueRub: ${avr}`);
  assert(avgValueRub(data, 100, 200) === null, 'avgValueRub insufficient');
}
console.log('avgValueRub OK');

console.log('\n=== dayRet ===');
{
  const data = [
    { d: '2025-01-01', c: 100 },
    { d: '2025-01-02', c: 105 },
  ];
  assert(approx(dayRet(data, 1), 5), `dayRet: ${dayRet(data, 1)}`);
  assert(dayRet(data, 0) === 0, 'dayRet first bar');
}
console.log('dayRet OK');

console.log('\n=== getTier ===');
{
  assert(getTier(8.0).name === 'ULTRA', 'tier ULTRA');
  assert(getTier(7.0).name === 'ULTRA', 'tier ULTRA boundary');
  assert(getTier(6.5).name === 'STRONG', 'tier STRONG');
  assert(getTier(6.9).name === 'STRONG', 'tier STRONG mid');
  assert(getTier(3.6).name === 'BASE', 'tier BASE');
  assert(getTier(5.0).name === 'BASE', 'tier BASE mid');
  assert(getTier(3.5) === null, 'tier null');
  assert(getTier(1.0) === null, 'tier null low');
}
console.log('getTier OK');

console.log('\n=== isDivGap ===');
{
  const data = [
    { d: '2025-06-01', o: 100, c: 100, h: 101, l: 99, v: 1000 },
    { d: '2025-06-02', o: 95,  c: 94,  h: 96,  l: 93, v: 800  },
  ];
  // Exact date match
  assert(isDivGap(data, 1, ['2025-06-02']), 'isDivGap exact');

  // Heuristic: drop >= 3%, VR < 2, gap down
  // ret = (94-100)/100*100 = -6% ✓, VR ~= 0.8 ✓, open 95 < close_prev 100 ✓
  // But we need 60 bars for avgVol — use fallback VR=99 when avgVol null
  // With avgVol null → vr = 99 → vr >= 2 → NOT div gap by heuristic
  assert(!isDivGapHeuristic(data, 1), 'isDivGapHeuristic no avgVol');

  // With enough history for avgVol
  const longData = makeBars(65, { v: 1000 });
  longData.push({ d: '2025-04-01', o: 95, c: 94, h: 96, l: 93, v: 800 });
  // VR = 800 / 1000 = 0.8 < 2 ✓
  // ret = (94-101)/101*100 = -6.9% < -3% ✓ (prev close = 101)
  // open 95 < prev close 101 ✓
  assert(isDivGapHeuristic(longData, 65), 'isDivGapHeuristic with data');
}
console.log('isDivGap OK');

console.log('\n=== scanTicker — signal detection ===');
{
  // Need volWin(60) + maPeriod(50) + atrWin(20) + scanWindow bars
  // startIdx = max(len - scanWindow, volWin + maPeriod) = max(len-5, 110)
  // So we need at least 115 bars for scanWindow=5
  const n = 120;
  const data = [];
  for (let i = 0; i < n; i++) {
    const month = Math.floor(i / 28) + 1;
    const day = (i % 28) + 1;
    data.push({
      d: `2025-${String(Math.min(month, 12)).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      o: 100,
      c: 101,
      h: 104,  // TR = max(4, |104-101|, |100-101|) = 4; atr% ≈ (4/101)*100 ≈ 3.96%
      l: 100,
      v: 1000,
    });
  }

  // Make bar at n-2 a signal: high VR, bull bar, close > MA50
  data[n - 2] = {
    d: '2025-04-20',
    o: 100,
    c: 105,  // bull bar, close > open
    h: 106,
    l: 99,
    v: 5000, // VR = 5000/1000 = 5.0 (BASE tier)
  };

  // Make bar at n-1 (T+1) with VR confirmation
  data[n - 1] = {
    d: '2025-04-21',
    o: 103,  // no gap cancel (103 < 105 * 1.06 = 111.3)
    c: 106,
    h: 107,
    l: 102,
    v: 2500, // VR ≈ 2.34 >= 2.0 ✓
  };

  const sigs = scanTicker(data, [], 5);
  assert(sigs.length === 1, `scanTicker found ${sigs.length} signals, expected 1`);
  if (sigs.length === 1) {
    const s = sigs[0];
    assert(s.date === '2025-04-20', `signal date: ${s.date}`);
    assert(approx(s.vr, 5.0, 0.1), `signal VR: ${s.vr}`);
    assert(s.tier.name === 'BASE', `signal tier: ${s.tier.name}`);
    assert(s.t1Status === 'confirmed', `T+1 status: ${s.t1Status}`);
    assert(s.strategy === 'S2', `strategy: ${s.strategy}`); // low turnover = S2
    assert(s.entryPrice !== null, 'entryPrice set');
    assert(s.catStop !== null, 'catStop set');
  }

  // Test: signal rejected when VR too low
  data[n - 2].v = 2000; // VR = 2.0 < 3.6
  assert(scanTicker(data, [], 5).length === 0, 'rejected low VR');
  data[n - 2].v = 5000; // restore

  // Test: signal rejected when bear bar
  data[n - 2].c = 99; // close < open
  assert(scanTicker(data, [], 5).length === 0, 'rejected bear bar');
  data[n - 2].c = 105; // restore

  // Test: gap cancel
  data[n - 1].o = 120; // open > close*1.06 = 111.3
  assert(scanTicker(data, [], 5).length === 0, 'gap cancel');
  data[n - 1].o = 103; // restore

  // Test: T+1 VR not confirmed
  data[n - 1].v = 500; // VR = 0.5 < 2.0
  assert(scanTicker(data, [], 5).length === 0, 'T+1 VR not confirmed');
  data[n - 1].v = 2500; // restore
}
console.log('scanTicker OK');

console.log('\n=== scanTickerFull ===');
{
  // Build 260 bars of history, place a signal somewhere
  const n = 260;
  const data = [];
  for (let i = 0; i < n; i++) {
    const month = Math.floor(i / 28) + 1;
    const day = (i % 28) + 1;
    data.push({
      d: `2025-${String(Math.min(month, 12)).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      o: 100,
      c: 101,
      h: 104,
      l: 100,
      v: 1000,
    });
  }

  // Signal at bar 200
  data[200] = { ...data[200], o: 100, c: 105, h: 106, l: 99, v: 5000 };
  // T+1 confirmation at bar 201
  data[201] = { ...data[201], o: 103, c: 106, h: 107, l: 102, v: 2500 };

  const sigs = scanTickerFull(data);
  assert(sigs.length >= 1, `scanTickerFull: ${sigs.length} signals`);
  if (sigs.length >= 1) {
    assert(sigs[0].ep > 0, 'entry price positive');
    assert(sigs[0].catStopPx > 0, 'catStop positive');
    assert(sigs[0].tier.name === 'BASE', `tier: ${sigs[0].tier.name}`);
  }
}
console.log('scanTickerFull OK');

// ─── Summary ───
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
