// panel.js — Web panel API server
// Spec: TRADING_SYSTEM_SPEC.txt, section 12.9
//
// Routes:
//   GET  /api/status      — mode, lastRunAt, positions, cash, exposure
//   GET  /api/positions   — open positions with details
//   GET  /api/history     — closed trades (last 100)
//   GET  /api/curve       — equity curve (last 500 points)
//   GET  /api/signals     — current pending signals (from last scan)
//   GET  /api/config      — robot parameters
//   GET  /api/logs        — last 50 log lines
//   POST /api/close/:ticker — request manual close
//   POST /api/force-scan    — trigger a cycle

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadState, saveState } from './state.js';
import { P } from './signals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const LOG_FILE = join(__dirname, 'robot.log');
const MODE_FILE = join(__dirname, 'mode.json');
let INDEX_HTML = '';
try { INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf8'); } catch {}

let _forceScanCallback = null;
let _lastCycleAt = null;
let _cycleIntervalMs = 10 * 60_000; // 10 min

/** Save mode to disk so it survives restarts. */
function persistMode(live) {
  try { writeFileSync(MODE_FILE, JSON.stringify({ live, savedAt: new Date().toISOString() })); } catch {}
}

/** Load persisted mode from disk. Returns null if not found. */
export function loadPersistedMode() {
  try {
    if (existsSync(MODE_FILE)) {
      const { live } = JSON.parse(readFileSync(MODE_FILE, 'utf8'));
      return typeof live === 'boolean' ? live : null;
    }
  } catch {}
  return null;
}

/** Called by robot after each cycle completes. */
export function markCycleCompleted() {
  _lastCycleAt = Date.now();
}

/**
 * Register a callback for force-scan POST requests.
 */
export function onForceScan(cb) {
  _forceScanCallback = cb;
}

/**
 * Start the web panel HTTP server.
 */
export function startPanel(port, modeRef, log) {
  // modeRef: { get() → bool, set(v) } for live toggling
  const isDryRun = () => typeof modeRef === 'object' ? modeRef.get() : modeRef;
  const srv = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    try {
      // ── Serve web panel ──
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(INDEX_HTML);
        return;
      }

      // ── GET routes ──
      if (req.method === 'GET') {
        const st = loadState();

        if (path === '/api/status') {
          const open = st.positions.filter(p => p.status === 'open');
          const exposure = open.reduce((sum, p) => sum + p.entryPrice * p.lots * (p.lotSize || 1), 0);
          return json(res, {
            mode: isDryRun() ? 'dry_run' : 'live',
            lastRunAt: st.lastRunAt,
            livePrimedAt: st.livePrimedAt,
            positionCount: open.length,
            cashRub: st.cashRub,
            exposureRub: exposure,
            processedSignals: Object.keys(st.processedSignals).length,
          });
        }

        if (path === '/api/positions') {
          return json(res, st.positions.filter(p => p.status === 'open'));
        }

        if (path === '/api/history') {
          return json(res, st.history.reverse());
        }

        if (path === '/api/curve') {
          return json(res, st.accountCurve);
        }

        if (path === '/api/signals') {
          // Show processed signals from the last day
          const recent = {};
          for (const [key, ts] of Object.entries(st.processedSignals)) {
            const age = Date.now() - ts;
            if (age < 86400_000) recent[key] = new Date(ts).toISOString();
          }
          return json(res, recent);
        }

        if (path === '/api/config') {
          return json(res, {
            P,
            DRY_RUN: isDryRun(),
            ACCOUNT: process.env.TKF_ACCOUNT_ID ? '***' : '',
            MAX_CAPITAL_RUB: 50_000,
          });
        }

        if (path === '/api/cycle-timer') {
          const nextIn = _lastCycleAt
            ? Math.max(0, _cycleIntervalMs - (Date.now() - _lastCycleAt))
            : null;
          return json(res, {
            lastCycleAt: _lastCycleAt ? new Date(_lastCycleAt).toISOString() : null,
            intervalMs: _cycleIntervalMs,
            nextInMs: nextIn,
          });
        }

        if (path === '/api/logs') {
          try {
            const raw = readFileSync(LOG_FILE, 'utf8');
            const lines = raw.trim().split('\n').slice(-50);
            return json(res, lines);
          } catch {
            return json(res, []);
          }
        }
      }

      // ── POST routes ──
      if (req.method === 'POST') {
        // POST /api/close/:ticker
        const closeMatch = path.match(/^\/api\/close\/([A-Z]+)$/);
        if (closeMatch) {
          const ticker = closeMatch[1];
          const st = loadState();
          const pos = st.positions.find(p => p.status === 'open' && p.ticker === ticker);
          if (!pos) {
            res.statusCode = 404;
            return json(res, { error: `No open position for ${ticker}` });
          }
          // Mark for manual close — robot will pick this up next cycle
          pos.manualClose = true;
          saveState(st);
          log(`PANEL: manual close requested for ${ticker}`);
          return json(res, { ok: true, ticker, message: 'Close requested, will execute next cycle' });
        }

        // POST /api/force-scan
        if (path === '/api/force-scan') {
          if (_forceScanCallback) {
            log('PANEL: force-scan triggered');
            _forceScanCallback();
            return json(res, { ok: true, message: 'Scan triggered' });
          }
          return json(res, { ok: false, message: 'No scan callback registered' });
        }

        // POST /api/mode — toggle dry_run / live (persisted to disk)
        if (path === '/api/mode') {
          const body = await readBody(req);
          const { live } = JSON.parse(body);
          if (typeof modeRef === 'object' && modeRef.set) {
            modeRef.set(!live);
            persistMode(live);
            log(`PANEL: mode changed to ${live ? 'LIVE' : 'DRY_RUN'} (persisted)`);
            return json(res, { ok: true, mode: live ? 'live' : 'dry_run' });
          }
          return json(res, { ok: false, message: 'Mode toggle not supported in this configuration' });
        }

        // POST /api/update — git pull + reload index.html
        if (path === '/api/update') {
          log('PANEL: git pull requested');
          try {
            const out = execSync('git pull origin main 2>&1', { cwd: ROOT_DIR, timeout: 30_000 }).toString();
            // Reload index.html after update
            try { INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf8'); } catch {}
            log('PANEL: update result — ' + out.trim());
            return json(res, { ok: true, message: out.trim() });
          } catch (e) {
            const msg = e.stderr?.toString() || e.stdout?.toString() || e.message;
            log('PANEL: update failed — ' + msg);
            return json(res, { ok: false, message: msg });
          }
        }

        // POST /api/reset-state — reset robot state (cash, positions, history, curve)
        if (path === '/api/reset-state') {
          const { emptyState } = await import('./state.js');
          const fresh = emptyState();
          saveState(fresh);
          log('PANEL: state reset to fresh (cash=50000, no positions)');
          return json(res, { ok: true, message: 'State reset to initial' });
        }

        // POST /api/restart — restart panel service via systemctl
        if (path === '/api/restart') {
          log('PANEL: restart requested');
          try {
            execSync('sudo systemctl restart moex-panel moex-robot 2>&1 || true', { timeout: 10_000 });
            return json(res, { ok: true, message: 'Перезапуск...' });
          } catch (e) {
            return json(res, { ok: false, message: e.message });
          }
        }
      }

      // 404
      res.statusCode = 404;
      json(res, { error: 'not found', routes: [
        'GET /api/status', 'GET /api/positions', 'GET /api/history',
        'GET /api/curve', 'GET /api/signals', 'GET /api/config', 'GET /api/logs',
        'POST /api/close/:ticker', 'POST /api/force-scan',
      ]});
    } catch (e) {
      res.statusCode = 500;
      json(res, { error: e.message });
    }
  });

  srv.listen(port, () => log(`Panel: http://localhost:${port}`));
  return srv;
}

function json(res, data) {
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}
