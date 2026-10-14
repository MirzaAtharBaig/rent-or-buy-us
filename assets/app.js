// UI for the rent-vs-buy simulator. Loads data/data.json, wires inputs, renders charts.
import { runSim, pmt } from './sim.js';

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PATHS = [{ k: 'fix', n: 'Buy, 30-year fixed' }, { k: 'arm', n: 'Buy, adjustable rate' }, { k: 'rent', n: 'Rent and invest' }];
const NUM = ['price', 'rent', 'years', 'downPct', 'fixedRate', 'armRate', 'armFixedYears', 'armMargin', 'armCap', 'armLife',
  'refiDrop', 'refiCostPct', 'closingPct', 'pmiPct', 'propTaxPct', 'assessCap', 'insPct', 'insExtraPct', 'maintPct', 'hoa',
  'rentersIns', 'stockPct', 'feePct', 'marginalPct', 'stateTax', 'ltcgPct', 'commissionPct', 'sellOtherPct', 'income',
  'otherDebt', 'block', 'index0'];
const CUSTOM = 'custom';

let D = null, BASE = null, N_SIMS = 1000, seed = 20261013, basis = 'real', histKey = 'hpa', last = null;
const charts = {};

const fmt = (v) => (!isFinite(v) ? '–' : (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US'));
function short(v) {
  const a = Math.abs(v), sg = v < 0 ? '−' : '';
  if (a >= 1e6) return sg + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'k';
  return sg + '$' + Math.round(a);
}
const pct = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d) + '%';
const colors = () => ({ fix: css('--fix'), arm: css('--arm'), rent: css('--rent'), ink: css('--ink'), muted: css('--muted'), rule: css('--rule'), neg: css('--neg') });

function baseDefaults() {
  const d = D.assumptions.defaults;
  return {
    years: d.years, downPct: d.down_pct, fixedRate: D.current.mortgage30,
    armRate: Math.round((D.current.mortgage30 - d.arm_spread) * 100) / 100, armFixedYears: d.arm_fixed_years,
    armMargin: d.arm_margin, armCap: d.arm_cap, armLife: d.arm_life, refiOn: true, refiDrop: d.refi_drop,
    refiCostPct: d.refi_cost_pct, closingPct: d.closing_pct, pmiPct: d.pmi_pct, insExtraPct: 0, maintPct: d.maint_pct,
    hoa: 0, rentersIns: d.renters_ins, stockPct: d.stock_pct, feePct: d.fee_pct, taxesOn: true, filing: 'mfj',
    marginalPct: d.marginal_pct, stateTax: 0, ltcgPct: d.ltcg_pct, commissionPct: d.commission_pct,
    sellOtherPct: d.sell_other_pct, income: d.income, otherDebt: 0, block: D.assumptions.simulation.block_years,
    index0: D.current.index1y,
  };
}

function metroOrder() {
  return Object.entries(D.metros).filter(([k]) => k !== 'national').sort((a, b) => a[1].name.localeCompare(b[1].name));
}
function initSelects() {
  const sel = $('metro'), hs = $('histSrc');
  const list = [['national', D.metros.national], ...metroOrder()];
  for (const [k, m] of list) {
    sel.add(new Option(m.name, k));
    hs.add(new Option(m.name, k));
  }
  sel.add(new Option('Somewhere else (enter your own numbers)', CUSTOM));
  sel.value = 'national';
}

function applyDefaults(place, keepGlobals) {
  if (!keepGlobals) {
    for (const [k, v] of Object.entries(BASE)) {
      const el = $(k); if (!el) continue;
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    }
  }
  const m = place === CUSTOM ? D.metros.national : D.metros[place];
  $('histSrc').value = place === CUSTOM ? 'national' : place;
  $('price').value = m.price; $('rent').value = m.rent; $('propTaxPct').value = m.prop_tax;
  $('insPct').value = m.ins; $('assessCap').value = m.assess_cap;
  $('yearsOut').textContent = $('years').value;
  const notes = place === CUSTOM
    ? ['Enter your home price, rent, property tax and insurance, then pick the price history that best matches your market. Defaults are U.S. national figures.']
    : [`${m.name}: Zillow typical home value ${fmt(m.price)} (${m.price_date}) and typical rent ${fmt(m.rent)}/mo (${m.rent_date}).`, ...m.notes];
  $('metroNote').textContent = notes.join(' ');
}

function readParams() {
  const p = { priceHistory: $('histSrc').value, place: $('metro').value, filing: $('filing').value,
    taxesOn: $('taxesOn').checked, refiOn: $('refiOn').checked,
    startYear: D.assumptions.simulation.start_year, mortgageFloor: D.assumptions.defaults.mortgage_floor };
  for (const k of NUM) { let v = parseFloat($(k).value); if (!isFinite(v)) v = 0; p[k] = v; }
  p.years = Math.round(Math.min(30, Math.max(3, p.years)));
  p.block = Math.round(Math.min(10, Math.max(1, p.block)));
  p.downPct = Math.min(100, Math.max(0, p.downPct));
  p.stockPct = Math.min(100, Math.max(0, p.stockPct));
  return p;
}

function run() {
  document.body.classList.add('busy');
  setTimeout(() => {
    const p = readParams();
    last = { p, o: runSim(p, D, N_SIMS, seed) };
    render();
    document.body.classList.remove('busy');
  }, 10);
}
let tmr = null;
const schedule = () => { clearTimeout(tmr); tmr = setTimeout(run, 250); };

function series(o, key, j, q, isCost) {
  const H = o.H, N = o.N, stride = isCost ? H : H + 1, res = [];
  for (let t = 0; t < stride; t++) {
    const a = new Float64Array(N);
    for (let s = 0; s < N; s++) {
      let v = o[key][j][s * stride + t];
      if (basis === 'real' && key !== 'sunkR') v /= o.cpi[s * (H + 1) + t];
      a[s] = v;
    }
    a.sort(); res.push(a[Math.floor(q * (N - 1) + 0.5)]);
  }
  return res;
}

function render() {
  const { p, o } = last, H = o.H, N = o.N, col = colors();
  const w = [0, 0, 0]; o.winner.forEach((x) => w[x]++);
  drawWaffle(o, col);
  const pc = (v) => Math.round((v / N) * 100), buy = w[0] + w[1];
  const place = p.place === CUSTOM ? 'your market' : p.place === 'national' ? 'a typical U.S. market' : D.metros[p.place].name;
  $('verdict').innerHTML = w[2] > buy
    ? `Selling after ${H} years in ${place}, renting and investing comes out ahead in <b>${pc(w[2])}%</b> of futures. Buying wins the other ${100 - pc(w[2])}% (fixed ${pc(w[0])}%, adjustable ${pc(w[1])}%).`
    : `Selling after ${H} years in ${place}, buying comes out ahead in <b>${pc(buy)}%</b> of futures (fixed ${pc(w[0])}%, adjustable ${pc(w[1])}%). Renting and investing wins the other ${100 - pc(buy)}%.`;

  const fin = (j) => { const a = new Float64Array(N); for (let s = 0; s < N; s++) { let v = o.nw[j][s * (H + 1) + H]; if (basis === 'real') v /= o.cpi[s * (H + 1) + H]; a[s] = v; } a.sort(); return [a[100], a[500], a[899]]; };
  const F = [fin(0), fin(1), fin(2)];
  const today = basis === 'real' ? " in today's dollars" : '';
  $('odds').innerHTML = PATHS.map((P, j) => `<div class="odd"><span class="sw" style="background:${col[P.k]}"></span><span class="lbl">${P.n}<small>Median net worth ${short(F[j][1])}${today}</small></span><b>${pc(w[j])}%</b></div>`).join('');
  $('kpis').innerHTML = PATHS.map((P, j) => `<div class="kpi"><div class="nm"><span class="sw" style="background:${col[P.k]}"></span>${P.n}</div><div class="v">${short(F[j][1])}</div><div class="r">10th–90th percentile: ${short(F[j][0])} to ${short(F[j][2])}</div></div>`).join('');

  const labels = Array.from({ length: H + 1 }, (_, t) => (t === 0 ? 'Now' : 'Yr ' + t));
  const alpha = (c, a) => { const m = c.match(/^#([0-9a-f]{6})$/i); if (!m) return c; const n = parseInt(m[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const band = (d, c) => ({ data: d, borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: alpha(c, 0.14) });
  const line = (d, c, lbl, dash) => ({ label: lbl, data: d, borderColor: c, backgroundColor: c, borderWidth: 2.5, pointRadius: 0, borderDash: dash || [], fill: false, tension: 0.2 });
  const md = (j) => series(o, 'nw', j, 0.5), lo = (j) => series(o, 'nw', j, 0.1), hi = (j) => series(o, 'nw', j, 0.9);
  drawChart('chNW', labels, [band(lo(0), col.fix), Object.assign(band(hi(0), col.fix), { fill: '-1' }), band(lo(2), col.rent), Object.assign(band(hi(2), col.rent), { fill: '-1' }),
    line(md(0), col.fix, PATHS[0].n), line(md(1), col.arm, PATHS[1].n, [6, 4]), line(md(2), col.rent, PATHS[2].n)], col, short);
  $('legendNW').innerHTML = PATHS.map((P) => `<span><i style="background:${col[P.k]}"></i>${P.n}</span>`).join('');

  const cl = Array.from({ length: H }, (_, t) => 'Yr ' + (t + 1));
  const cm = [0, 1, 2].map((j) => series(o, 'cost', j, 0.5, true));
  drawChart('chCost', cl, [line(cm[0], col.fix, PATHS[0].n), line(cm[1], col.arm, PATHS[1].n, [6, 4]), line(cm[2], col.rent, PATHS[2].n)], col, (v) => '$' + Math.round(v).toLocaleString('en-US'), true);

  let crossCount = 0; const crossYears = [];
  for (let s = 0; s < N; s++) for (let y = 0; y < H; y++) if (o.cost[2][s * H + y] > o.cost[0][s * H + y]) { crossCount++; crossYears.push(y + 1); break; }
  crossYears.sort((a, b) => a - b);
  const y1 = [o.cost[0], o.cost[2]].map((a) => { let t = 0; for (let s = 0; s < N; s++) t += a[s * H]; return t / N; });
  const refiShare = o.refis.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  const refiTxt = p.refiOn ? ` The fixed-rate owner refinanced at least once in ${pc(refiShare)}% of futures.` : '';
  $('crossNote').innerHTML = (y1[1] >= y1[0]
    ? "Rent already costs more than the fixed-rate owner's outlay in year one, so the owner does the investing from the start."
    : crossCount
      ? `Renting starts ${short(y1[0] - y1[1])}/mo cheaper. Rent overtakes the fixed-rate owner's monthly cost within ${H} years in <b>${pc(crossCount)}%</b> of futures — typically in year <b>${crossYears[Math.floor(crossYears.length / 2)]}</b>. After that, the renter stops adding to savings and the owner starts.`
      : `Renting starts ${short(y1[0] - y1[1])}/mo cheaper and stays cheaper than the fixed-rate owner's outlay for all ${H} years in every future.`) + refiTxt;

  const sm = [0, 1, 2].map((j) => series(o, basis === 'real' ? 'sunkR' : 'sunk', j, 0.5));
  drawChart('chSunk', labels, [line(sm[0], col.fix, PATHS[0].n), line(sm[1], col.arm, PATHS[1].n, [6, 4]), line(sm[2], col.rent, PATHS[2].n)], col, short, true);

  renderYear1(p); renderYears(o, H); renderHist(p, col);
}

function drawChart(id, labels, datasets, col, tick, showLegend) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), {
    type: 'line', data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !!showLegend, labels: { color: col.muted, boxWidth: 18, boxHeight: 3, filter: (i) => !!i.text } },
        tooltip: { filter: (i) => !!i.dataset.label, callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: col.muted, maxTicksLimit: 10, autoSkip: true }, grid: { display: false }, border: { color: col.rule } },
        y: { ticks: { color: col.muted, callback: tick }, grid: { color: col.rule }, border: { display: false } },
      },
    },
  });
}

function drawWaffle(o, col) {
  const cv = $('waffle'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 600, Hh = (W * 20) / 50;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, Hh);
  const sorted = Array.from(o.winner).sort((a, b) => a - b), cell = W / 50, r = cell * 0.36, cs = [col.fix, col.arm, col.rent];
  sorted.forEach((wv, i) => { const x = Math.floor(i / 20), y = i % 20; c.beginPath(); c.arc(x * cell + cell / 2, y * cell + cell / 2, r, 0, Math.PI * 2); c.fillStyle = cs[wv]; c.fill(); });
}

function renderYear1(p) {
  const loan = p.price * (1 - p.downPct / 100), pi = pmt(p.fixedRate / 100 / 12, 360, loan), pmi = p.downPct < 20 ? (loan * p.pmiPct) / 100 / 12 : 0;
  const tax = (p.price * p.propTaxPct) / 100 / 12, ins = (p.price * p.insPct) / 100 / 12, mt = (p.price * p.maintPct) / 100 / 12, hoa = p.hoa;
  const tot = pi + pmi + tax + ins + mt + hoa, down = (p.price * p.downPct) / 100, close = (p.price * p.closingPct) / 100;
  const rows = [['Down payment', down, 0, 1], ['Closing costs', close, 0, 1], ['Cash needed at purchase', down + close, 1, 1],
    ['Principal and interest', pi], ['PMI', pmi], ['Property tax', tax], ['Home insurance', ins], ['Maintenance', mt], ['HOA', hoa],
    ['Owner total per month', tot, 1], ["Rent + renter's insurance", p.rent + p.rentersIns], ['Difference per month', tot - (p.rent + p.rentersIns), 1]];
  $('tblY1').innerHTML = '<thead><tr><th>Year one</th><th>Amount</th></tr></thead><tbody>' +
    rows.map(([a, b, t, once]) => `<tr${t ? ' class="tot"' : ''}><td>${a}</td><td>${fmt(b)}${once ? '' : '/mo'}</td></tr>`).join('') + '</tbody>';
  const inc = p.income / 12, housing = pi + pmi + tax + ins + hoa;
  const fe = inc > 0 ? (housing / inc) * 100 : NaN, be = inc > 0 ? ((housing + p.otherDebt) / inc) * 100 : NaN, rs = inc > 0 ? (p.rent / inc) * 100 : NaN;
  const flag = (v, a, b, c) => !isFinite(v) ? '' : v <= a ? '<span class="flag ok">within guideline</span>' : v <= b ? '<span class="flag warn">stretch</span>' : v <= c ? '<span class="flag warn">needs automated approval</span>' : '<span class="flag bad">over typical limits</span>';
  const ar = [['Housing cost / income', fe, flag(fe, 28, 36, 99)], ['Total debt-to-income', be, flag(be, 36, 45, 50)], ['Rent / income', rs, flag(rs, 30, 40, 99)]];
  $('tblAfford').innerHTML = '<thead><tr><th>Ratio</th><th>Value</th><th>Status</th></tr></thead><tbody>' +
    ar.map(([a, b, c]) => `<tr><td>${a}</td><td>${isFinite(b) ? b.toFixed(1) + '%' : '–'}</td><td>${c}</td></tr>`).join('') +
    '<tr><td colspan="3" style="white-space:normal;color:var(--muted);font-size:.82rem;text-align:left">Housing cost excludes maintenance, as lenders do. The 28% housing / 36% total guideline is a common rule of thumb; Fannie Mae allows total DTI up to 45% on manually underwritten loans with compensating factors and up to 50% through Desktop Underwriter. Rent share uses HUD\'s 30% cost-burden benchmark.</td></tr></tbody>';
}

function renderYears(o, H) {
  const nw = [0, 1, 2].map((j) => series(o, 'nw', j, 0.5)), c = [0, 1, 2].map((j) => series(o, 'cost', j, 0.5, true));
  const hv = [];
  for (let t = 0; t <= H; t++) { const a = new Float64Array(o.N); for (let s = 0; s < o.N; s++) { let v = o.home[s * (H + 1) + t]; if (basis === 'real') v /= o.cpi[s * (H + 1) + t]; a[s] = v; } a.sort(); hv.push(a[Math.floor(0.5 * (o.N - 1) + 0.5)]); }
  let h = '<thead><tr><th>Year</th><th>Home value</th><th>Fixed owner net worth</th><th>ARM owner net worth</th><th>Renter net worth</th><th>Fixed cost/mo</th><th>ARM cost/mo</th><th>Rent cost/mo</th></tr></thead><tbody>';
  for (let t = 0; t <= H; t++) h += `<tr><td>${t === 0 ? 'Now' : t}</td><td>${fmt(hv[t])}</td>${nw.map((a) => `<td${a[t] < 0 ? ' class="neg"' : ''}>${fmt(a[t])}</td>`).join('')}${c.map((a) => `<td>${t === 0 ? '–' : fmt(a[t - 1])}</td>`).join('')}</tr>`;
  $('tblYears').innerHTML = h + '</tbody>';
}

const HKEYS = [['hpa', 'Home prices'], ['rent', 'Rent'], ['cpi', 'Inflation'], ['stocks', 'S&P 500'], ['bonds', '10-yr Treasury'], ['gs1', '1-yr yield']];
function renderHist(p, col) {
  const m = D.metros[p.priceHistory];
  $('histSeg').innerHTML = HKEYS.map(([k, l]) => `<button type="button" data-h="${k}" aria-pressed="${k === histKey}">${l}</button>`).join('');
  const d = histKey === 'hpa' ? m.hpa : D.national[histKey], isLevel = histKey === 'gs1';
  const c = histKey === 'hpa' ? col.fix : histKey === 'rent' ? col.rent : histKey === 'stocks' || histKey === 'bonds' ? col.arm : col.ink;
  if (charts.chHist) charts.chHist.destroy();
  charts.chHist = new Chart($('chHist'), {
    type: 'bar', data: { labels: D.years, datasets: [{ label: HKEYS.find((x) => x[0] === histKey)[1], data: d, backgroundColor: d.map((v) => (v < 0 ? col.neg : c)), borderRadius: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => (isLevel ? x.parsed.y.toFixed(2) + '% average yield' : pct(x.parsed.y, 2)) } } },
      scales: { x: { ticks: { color: col.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 13 }, grid: { display: false } },
        y: { ticks: { color: col.muted, callback: (v) => v + '%' }, grid: { color: col.rule }, border: { display: false } } } },
  });
  const cg = (a) => (a.reduce((x, v) => x * (1 + v / 100), 1) ** (1 / a.length) - 1) * 100;
  const label = HKEYS.find((x) => x[0] === histKey)[1];
  $('histNote').textContent = isLevel
    ? 'Annual average 1-year Treasury yield. The simulator uses its year-to-year changes to move the ARM index.'
    : `${label}${histKey === 'hpa' ? ' in ' + m.name : ''}: compound average ${cg(d).toFixed(2)}% a year over ${D.years[0]}–${D.years.at(-1)}; best year ${pct(Math.max(...d), 1)}, worst ${pct(Math.min(...d), 1)}.${histKey === 'hpa' ? ' Source: ' + m.hpa_source + '.' : ''}`;
  const ths = ['Year', `Home prices (${m.name})`, 'Rent (CPI)', 'Inflation (CPI-U)', 'S&P 500 total return', '10-yr Treasury total return', '1-yr Treasury yield (avg)'];
  let h = '<thead><tr>' + ths.map((t) => `<th>${t}</th>`).join('') + '</tr></thead><tbody>';
  D.years.forEach((y, i) => {
    const r = [m.hpa[i], D.national.rent[i], D.national.cpi[i], D.national.stocks[i], D.national.bonds[i]];
    h += `<tr><td>${y}</td>${r.map((v) => `<td${v < 0 ? ' class="neg"' : ''}>${pct(v, 2)}</td>`).join('')}<td>${D.national.gs1[i].toFixed(2)}%</td></tr>`;
  });
  $('tblHist').innerHTML = h + '</tbody>';
}

function wire() {
  initSelects();
  applyDefaults('national', false);
  $('rateNote').textContent = `Freddie Mac PMMS, week of ${D.current.mortgage30_date}`;
  $('indexNote').textContent = `1-year Treasury yield, ${D.current.index1y_date}`;
  $('dataStamp').textContent = `Data built ${D.meta.built_at} (${D.meta.source}); history window ${D.meta.window[0]}–${D.meta.window[1]}.` + (D.meta.source === 'seed' ? ' ' + D.meta.notes : '');
  $('metro').addEventListener('change', (e) => { applyDefaults(e.target.value, true); schedule(); });
  document.querySelectorAll('aside input, aside select').forEach((el) => {
    if (el.id === 'metro') return;
    el.addEventListener('input', () => { if (el.id === 'years') $('yearsOut').textContent = el.value; schedule(); });
    el.addEventListener('change', schedule);
  });
  $('reshuffle').addEventListener('click', () => { seed = Math.floor(Math.random() * 1e9); run(); });
  $('resetBtn').addEventListener('click', () => { applyDefaults($('metro').value, false); run(); });
  document.querySelectorAll('[data-basis]').forEach((b) => b.addEventListener('click', () => {
    basis = b.dataset.basis;
    document.querySelectorAll('[data-basis]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (last) render();
  }));
  $('histSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-h]'); if (!b) return; histKey = b.dataset.h; if (last) renderHist(last.p, colors()); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (last) render(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (last) drawWaffle(last.o, colors()); }, 150); });
  run();
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const text = $(b.dataset.copy).textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = old), 1500);
  } catch { b.textContent = 'Copy failed — select the text manually'; }
}));
}

async function init() {
  if (typeof Chart === 'undefined') { $('verdict').textContent = 'The chart library did not load. Check your connection and reload.'; return; }
  try {
    const r = await fetch('data/data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    D = await r.json();
  } catch (err) {
    $('verdict').textContent = `Could not load data/data.json (${err.message}). If you opened the file directly, serve the folder instead (see README).`;
    return;
  }
  N_SIMS = D.assumptions.simulation.futures;
  BASE = baseDefaults();
  wire();
}
init();
