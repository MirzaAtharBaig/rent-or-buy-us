// Engine tests. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pmt, runSim, saltCapFor, mulberry32 } from '../assets/sim.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

/** Synthetic dataset where every annual change is zero unless overridden. */
function flatData(n = 25, over = {}) {
  const z = () => Array(n).fill(0);
  return {
    years: Array.from({ length: n }, (_, i) => 2001 + i),
    national: { cpi: z(), rent: z(), stocks: z(), bonds: z(), gs1: z(), dGs1: z(), dM30: z(), ...over },
    metros: { x: { hpa: over.hpa ?? z() } },
  };
}
const P = {
  priceHistory: 'x', years: 10, price: 400000, rent: 2000, downPct: 20, closingPct: 0, fixedRate: 6, armRate: 6,
  armFixedYears: 5, armMargin: 2.75, armCap: 2, armLife: 5, index0: 3.25, refiOn: false, refiDrop: 1, refiCostPct: 2,
  mortgageFloor: 2, pmiPct: 0.5, propTaxPct: 0, assessCap: 0, insPct: 0, insExtraPct: 0, maintPct: 0, hoa: 0,
  rentersIns: 0, stockPct: 60, feePct: 0, block: 5, commissionPct: 0, sellOtherPct: 0, filing: 'mfj',
  marginalPct: 22, stateTax: 0, ltcgPct: 15, taxesOn: false, startYear: 2027,
};

test('pmt matches the closed-form payment', () => {
  close(pmt(0.06 / 12, 360, 300000), 1798.65, 0.01, '300k at 6%');
  close(pmt(0, 120, 12000), 100, 1e-9, 'zero rate');
  assert.equal(pmt(0.05, 0, 1000), 0);
});

test('SALT cap follows current law', () => {
  assert.equal(saltCapFor(2025), 40000);
  close(saltCapFor(2026), 40400, 1e-6);
  assert.equal(saltCapFor(2030), 10000);
});

test('PRNG is deterministic for a seed', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('flat world: fixed owner equity equals the amortization schedule', () => {
  const o = runSim({ ...P, rent: 1500 }, flatData(), 1, 1);
  const r = 0.06 / 12, n = 360, L = 320000, k = 120;
  const balAfter = L * (Math.pow(1 + r, n) - Math.pow(1 + r, k)) / (Math.pow(1 + r, n) - 1);
  // Owner invests nothing when rent is cheaper, so owner net worth is pure equity.
  const ownerPayment = pmt(r, n, L);
  assert.ok(ownerPayment > 1500, 'test setup: owner pays more than rent');
  close(o.nw[0][P.years], 400000 - balAfter, 0.5, 'owner equity');
  // Renter: down payment plus 120 months of (payment - rent), all at 0% return.
  close(o.nw[2][P.years], 80000 + 120 * (ownerPayment - 1500), 0.5, 'renter savings');
});

test('PMI is charged below 20% down and stops at 78% of original value', () => {
  const p = { ...P, downPct: 10, years: 30 };
  const o = runSim(p, flatData(30), 1, 1);
  const base = pmt(0.06 / 12, 360, 360000);
  close(o.cost[0][0], base + (360000 * 0.005) / 12, 0.01, 'year-1 cost includes PMI');
  close(o.cost[0][29], base, 0.01, 'year-30 cost has no PMI');
});

test('backtest: explicit sequence reproduces cumulative home price growth', () => {
  const hpa = Array.from({ length: 25 }, (_, i) => (i % 3) - 0.5);
  const D = flatData(25, { hpa });
  const p = { ...P, years: 25 };
  const seq = [Array.from({ length: 25 }, (_, i) => i)];
  const o = runSim(p, D, 1, 1, seq);
  const expected = hpa.reduce((v, g) => v * (1 + g / 100), 400000);
  close(o.home[25], expected, 1e-6, 'final home value');
});

test('refinance triggers when market rates fall by the threshold and lowers the payment', () => {
  const dM30 = Array(25).fill(0); dM30[1] = -2; // second simulated year: rates fall 2 points
  const D = flatData(25, { dM30 });
  const seq = [Array.from({ length: 25 }, (_, i) => i)];
  const off = runSim({ ...P, years: 5 }, D, 1, 1, seq);
  const on = runSim({ ...P, years: 5, refiOn: true }, D, 1, 1, seq);
  assert.equal(off.refis[0], 0);
  assert.equal(on.refis[0], 1);
  assert.ok(on.cost[0][4] < off.cost[0][4], 'payment drops after refinancing');
});

test('same seed gives identical results on real data', () => {
  const D = JSON.parse(readFileSync(new URL('../data/data.json', import.meta.url)));
  const p = { ...P, priceHistory: 'national', years: 25, block: 5 };
  const a = runSim(p, D, 200, 7), b = runSim(p, D, 200, 7);
  assert.deepEqual(Array.from(a.winner), Array.from(b.winner));
});
