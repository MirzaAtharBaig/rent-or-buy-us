// Rent-vs-buy Monte Carlo engine. Pure functions, no DOM access.
// Runs in the browser (ES module) and in Node for tests.

/** Seeded PRNG (mulberry32) so every run is reproducible from its seed. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Level payment for a fully amortizing loan. r = periodic rate, n = periods. */
export function pmt(r, n, pv) {
  if (n <= 0 || pv <= 0) return 0;
  if (r === 0) return pv / n;
  return (pv * r) / (1 - Math.pow(1 + r, -n));
}

/** SALT cap under current law (P.L. 119-21): $40,000 in 2025, +1%/yr through 2029, $10,000 from 2030. */
export function saltCapFor(year) {
  if (year <= 2025) return 40000;
  if (year <= 2029) return 40000 * Math.pow(1.01, year - 2025);
  return 10000;
}

/** Sequence of historical year indices for one future (circular block bootstrap). */
export function sampleSequence(rng, nYears, horizon, block) {
  const idx = [];
  while (idx.length < horizon) {
    const start = Math.floor(rng() * nYears);
    for (let k = 0; k < block && idx.length < horizon; k++) idx.push((start + k) % nYears);
  }
  return idx;
}

/**
 * Run the simulation.
 * @param {object} p    user parameters (see defaults in app.js)
 * @param {object} D    contents of data/data.json
 * @param {number} N    number of futures
 * @param {number} seed PRNG seed
 * @param {number[][]} [sequences] explicit year-index sequences (one per future), used for backtests
 * Paths: 0 = buy with 30-year fixed, 1 = buy with ARM, 2 = rent and invest.
 */
export function runSim(p, D, N, seed, sequences) {
  const H = p.years, rng = mulberry32(seed), NY = D.years.length;
  const nat = D.national, hpa = D.metros[p.priceHistory].hpa;
  const mk = (n) => [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const out = {
    nw: mk(N * (H + 1)), cost: mk(N * H), sunk: mk(N * (H + 1)), sunkR: mk(N * (H + 1)),
    home: new Float64Array(N * (H + 1)), cpi: new Float64Array(N * (H + 1)),
    refis: new Uint16Array(N), winner: new Uint8Array(N), H, N,
  };
  const price = p.price, dp = p.downPct / 100, loan = price * (1 - dp), closing = (price * p.closingPct) / 100;
  const sellPct = (p.commissionPct + p.sellOtherPct) / 100, excl = p.filing === 'mfj' ? 500000 : 250000;
  const stdBase = p.filing === 'mfj' ? 32200 : 16100, mirShare = loan > 0 ? Math.min(1, 750000 / loan) : 1;
  const fee = p.feePct / 100, wS = p.stockPct / 100;
  const ltcg = p.taxesOn ? p.ltcgPct / 100 : 0, marg = p.taxesOn ? p.marginalPct / 100 : 0;
  const pmiOn = dp < 0.2, pmiM = (loan * p.pmiPct) / 100 / 12, pmiStop = 0.78 * price; // HPA 1998 automatic termination

  for (let s = 0; s < N; s++) {
    const idx = sequences ? sequences[s % sequences.length] : sampleSequence(rng, NY, H, p.block);
    let home = price, assessed = price, cpiL = 1;
    const bal = [loan, loan], rate = [p.fixedRate / 100, p.armRate / 100], mLeft = [360, 360];
    const pay = [pmt(rate[0] / 12, 360, loan), pmt(rate[1] / 12, 360, loan)];
    let ix = p.index0, mkt = p.fixedRate, refis = 0;
    let rent = p.rent, rIns = p.rentersIns, ins = (price * p.insPct) / 100, hoa = p.hoa;
    const port = [0, 0, price * dp + closing], basis = [port[0], port[1], port[2]];
    const sunk = [closing, closing, 0], sunkR = [closing, closing, 0];
    const base = s * (H + 1);
    out.nw[0][base] = out.nw[1][base] = price * (1 - sellPct) - loan; out.nw[2][base] = port[2];
    out.cpi[base] = 1; out.home[base] = price;
    out.sunk[0][base] = out.sunk[1][base] = out.sunkR[0][base] = out.sunkR[1][base] = closing + price * sellPct;

    for (let y = 0; y < H; y++) {
      const k = idx[y], g = hpa[k] / 100, rg = nat.rent[k] / 100, inf = nat.cpi[k] / 100;
      const ret = (wS * nat.stocks[k]) / 100 + ((1 - wS) * nat.bonds[k]) / 100 - fee, mret = Math.pow(1 + ret, 1 / 12) - 1;
      ix = Math.max(0, ix + nat.dGs1[k]);
      mkt = Math.max(p.mortgageFloor, mkt + nat.dM30[k]);

      // Refinance the fixed loan when market rates have fallen far enough. Costs are rolled into the balance.
      if (p.refiOn && y > 0 && bal[0] > 0 && mkt <= rate[0] * 100 - p.refiDrop) {
        const cost = (bal[0] * p.refiCostPct) / 100;
        bal[0] += cost; sunk[0] += cost; rate[0] = mkt / 100; pay[0] = pmt(rate[0] / 12, mLeft[0], bal[0]); refis++;
      }
      // ARM reset: index + margin, limited by the per-year cap and lifetime cap, floored at the margin.
      if (y >= p.armFixedYears && bal[1] > 0) {
        const cap = p.armCap / 100;
        let nr = (ix + p.armMargin) / 100;
        nr = Math.min(Math.max(nr, rate[1] - cap), rate[1] + cap);
        nr = Math.min(nr, (p.armRate + p.armLife) / 100);
        nr = Math.max(nr, p.armMargin / 100);
        if (Math.abs(nr - rate[1]) > 1e-9) { rate[1] = nr; pay[1] = pmt(nr / 12, mLeft[1], bal[1]); }
      }

      const propTax = (assessed * p.propTaxPct) / 100, maint = (home * p.maintPct) / 100;
      const common = (propTax + maint + ins) / 12 + hoa;
      const interest = [0, 0], spent = [0, 0, 0], sunk0 = [sunk[0], sunk[1], sunk[2]], cpiStart = cpiL;

      for (let m = 0; m < 12; m++) {
        const o = [common, common, rent + rIns];
        for (let j = 0; j < 2; j++) {
          if (bal[j] > 0) {
            const i = (bal[j] * rate[j]) / 12, pr = Math.min(pay[j] - i, bal[j]);
            if (pmiOn && bal[j] > pmiStop) { o[j] += pmiM; sunk[j] += pmiM; }
            bal[j] -= pr; interest[j] += i; o[j] += i + pr; mLeft[j]--; sunk[j] += i;
          }
          sunk[j] += common;
        }
        sunk[2] += o[2];
        // Equal budgets: each household spends the costliest path's outlay; the difference is invested.
        const B = Math.max(o[0], o[1], o[2]);
        for (let j = 0; j < 3; j++) { port[j] = port[j] * (1 + mret) + (B - o[j]); basis[j] += B - o[j]; spent[j] += o[j]; }
      }

      const ben = [0, 0];
      if (marg > 0) {
        const std = stdBase * cpiL, cap = saltCapFor(p.startYear + y), st = p.stateTax * cpiL;
        const baseR = Math.max(std, Math.min(cap, st));
        for (let j = 0; j < 2; j++) {
          const item = Math.min(cap, propTax + st) + interest[j] * mirShare;
          ben[j] = marg * Math.max(0, Math.max(std, item) - baseR);
          port[j] += ben[j]; basis[j] += ben[j]; sunk[j] -= ben[j];
        }
      }
      for (let j = 0; j < 3; j++) out.cost[j][s * H + y] = (spent[j] - (j < 2 ? ben[j] : 0)) / 12;
      for (let j = 0; j < 3; j++) sunkR[j] += (sunk[j] - sunk0[j]) / cpiStart;

      home *= 1 + g;
      assessed = p.assessCap > 0 ? Math.min(assessed * (1 + p.assessCap / 100), home) : home;
      rent *= 1 + rg; rIns *= 1 + inf; ins *= 1 + inf + p.insExtraPct / 100; hoa *= 1 + inf; cpiL *= 1 + inf;

      const b = base + y + 1;
      out.cpi[b] = cpiL; out.home[b] = home;
      const sale = home * (1 - sellPct), cg = Math.max(0, sale - (price + closing) - excl) * ltcg;
      const after = (j) => port[j] - Math.max(0, port[j] - basis[j]) * ltcg;
      out.nw[0][b] = sale - bal[0] - cg + after(0);
      out.nw[1][b] = sale - bal[1] - cg + after(1);
      out.nw[2][b] = after(2);
      out.sunk[0][b] = sunk[0] + home * sellPct + cg; out.sunk[1][b] = sunk[1] + home * sellPct + cg; out.sunk[2][b] = sunk[2];
      out.sunkR[0][b] = sunkR[0] + (home * sellPct + cg) / cpiL;
      out.sunkR[1][b] = sunkR[1] + (home * sellPct + cg) / cpiL;
      out.sunkR[2][b] = sunkR[2];
    }
    let w = 0; for (let j = 1; j < 3; j++) if (out.nw[j][base + H] > out.nw[w][base + H]) w = j;
    out.winner[s] = w; out.refis[s] = refis;
  }
  return out;
}
