// Quick smoke test for tinkoff.js
import { getAccounts, getShares, getLastPrices, getPositions, getPortfolio, quotToNum, numToQuot } from './tinkoff.js';
import { readFileSync } from 'fs';

// Load token from .env
const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
const TOKEN = env.match(/TKF_TOKEN=(.+)/)?.[1]?.trim();
if (!TOKEN) { console.error('No TKF_TOKEN in .env'); process.exit(1); }

console.log('=== quotToNum / numToQuot ===');
console.log('quotToNum({units:"123",nano:450000000}) =', quotToNum({ units: '123', nano: 450000000 }));
console.log('numToQuot(123.45) =', JSON.stringify(numToQuot(123.45)));
console.log();

try {
  console.log('=== getAccounts ===');
  const accounts = await getAccounts(TOKEN);
  for (const a of accounts) {
    console.log(`  ${a.id}  ${a.name || '(no name)'}  type=${a.type}  status=${a.status}`);
  }

  const accountId = accounts.find(a => a.type === 'ACCOUNT_TYPE_TINKOFF')?.id || accounts[0]?.id;
  console.log(`\nUsing accountId: ${accountId}\n`);

  console.log('=== getShares (first 5) ===');
  const shares = await getShares(TOKEN);
  console.log(`  Total tradeable shares: ${shares.length}`);
  for (const s of shares.slice(0, 5)) {
    console.log(`  ${s.ticker}  lot=${s.lot}  figi=${s.figi}  uid=${s.uid}`);
  }

  if (accountId) {
    console.log('\n=== getPositions ===');
    const pos = await getPositions(TOKEN, accountId);
    const rub = pos.money?.find(m => m.currency === 'rub');
    console.log(`  Cash RUB: ${rub ? quotToNum(rub) : 'N/A'}`);
    console.log(`  Securities: ${pos.securities?.length || 0}`);
    for (const s of (pos.securities || []).slice(0, 5)) {
      console.log(`    uid=${s.instrumentUid}  balance=${s.balance}  blocked=${s.blocked || 0}`);
    }

    console.log('\n=== getPortfolio ===');
    const pf = await getPortfolio(TOKEN, accountId);
    console.log(`  Total: ${quotToNum(pf.totalAmountPortfolio)} RUB`);
    console.log(`  Positions: ${pf.positions?.length || 0}`);
    for (const p of (pf.positions || []).slice(0, 5)) {
      console.log(`    ${p.figi}  qty=${quotToNum(p.quantity)}  avgPx=${quotToNum(p.averagePositionPrice)}`);
    }
  }

  console.log('\n=== ALL OK ===');
} catch (e) {
  console.error('ERROR:', e.message);
  if (e.body) console.error('Body:', JSON.stringify(e.body, null, 2));
  process.exit(1);
}
