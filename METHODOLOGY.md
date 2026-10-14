# Methodology

## Overview

Three households start with the same cash: down payment plus buyer closing costs.

| Path | Housing | Savings |
|---|---|---|
| Buy, fixed | 30-year fixed at today's Freddie Mac rate; optional refinance | Invests whenever its outlay is below the costliest path's |
| Buy, ARM | Starting rate for the fixed period, then annual resets | Same |
| Rent | Rent + renter's insurance | Invests the starting cash on day one, then the monthly difference |

**Equal budgets.** Each month every household spends the outlay of the most expensive path that month. The difference between that and its own outlay goes into a stock/bond portfolio. This follows CBC's design (the renter invests savings) and extends it symmetrically: when rent overtakes an owner's payment, the owner invests the gap.

**Winner** = highest net worth after the final sale and taxes.

## Futures (circular block bootstrap)

The history window is set in `config/assumptions.yaml` (default 2001–2025, 25 years). Each future strings together blocks of consecutive historical years (default 5) starting at random points, wrapping from the last year to the first. A sampled year carries all its values together:

- home price change (selected location)
- CPI rent change, CPI-U inflation
- S&P 500 and 10-year Treasury total returns
- change in the 1-year Treasury yield (ARM index)
- change in the 30-year mortgage rate (refinance trigger)

Keeping each year's values together preserves cross-correlations, for example 2008's crash alongside falling rates. Blocks preserve short-run momentum. Interest-rate *levels* are not resampled: rates start at today's level and move by sampled year-over-year changes, floored at 0 (index) and `mortgage_floor` (mortgage).

## Monthly mechanics

**Mortgage.** Payment `P = L·r / (1 − (1+r)^−n)` with `r` the monthly rate. Interest is charged on the opening balance each month.

**PMI.** Charged at `pmi_pct × original loan / 12` when the down payment is under 20%. It stops once the balance falls to 78% of the purchase price, the automatic-termination point under the Homeowners Protection Act of 1998.

**Refinance (fixed path).** At the start of each year after the first, if the market rate ≤ current rate − `refi_drop`:
- the cost `refi_cost_pct × balance` is rolled into the balance;
- the rate resets to the market rate;
- the payment is recomputed over the remaining term (the term is not extended).

**ARM.** For years ≥ the fixed period:

```
new = clamp(index + margin, old − cap, old + cap)
new = min(new, start + lifetime cap)
new = max(new, margin)
```

The payment is re-amortized over the remaining term. Real loans reset off SOFR, often every six months. The 1-year Treasury is used because it has the full history.

**Owner costs.**
- property tax = rate × assessed value, where assessed value follows market value, limited by any assessment-growth cap;
- maintenance = rate × current value;
- insurance starts at rate × price and grows with CPI plus an optional extra;
- HOA grows with CPI.

**Rent** grows by sampled CPI rent. **Renter's insurance** grows with CPI.

**Portfolio.** Annual return = `w·stocks + (1−w)·bonds − fee`, applied monthly as `(1+R)^(1/12) − 1`.

## Taxes (federal, optional)

- **Itemizing benefit.** Each year:
  ```
  benefit = marginal × [max(std, SALT_owner + interest × min(1, 750k/loan)) − max(std, SALT_renter)]
  ```
  - `SALT_owner = min(cap, property tax + state income tax)`; `SALT_renter = min(cap, state income tax)`.
  - Standard deduction: $32,200 (joint) or $16,100 (single), grown with inflation.
  - SALT cap: $40,000 in 2025, +1% a year through 2029, $10,000 from 2030 (P.L. 119-21). The high-income phase-down is not modeled.
  - The benefit is credited to the owner's portfolio at year end.
- **Home sale.** The gain above the purchase price plus closing costs, less the §121 exclusion ($500,000 joint, $250,000 single), is taxed at the long-term capital gains rate.
- **Portfolios.** Unrealized gains are taxed at the capital gains rate at the end.
- **Not modeled:** dividend taxes during the holding period, state capital gains tax, and the alternative minimum tax (AMT).

## Outputs

- **Net worth.** Owners: sale price × (1 − selling costs) − balance − tax + portfolio after tax. Renter: portfolio after tax.
- **Today's dollars.** Each future is deflated by its own simulated CPI path.
- **Unrecoverable costs.**
  - Renter: rent.
  - Owners: interest, PMI, property tax, insurance, maintenance, HOA, refinance costs, closing and selling costs, net of tax benefit.
  - Principal is excluded because it becomes equity.
- **Percentiles.** Computed separately per year and per series, so the median rows of a table don't reconcile exactly.

## Verification

| Check | Where |
|---|---|
| Payment formula vs closed form ($300k at 6% → $1,798.65) | `tests/sim.test.mjs` |
| Flat world: owner equity = amortization schedule; renter savings = down payment + Σ(payment − rent) | `tests/sim.test.mjs` |
| PMI present in year 1, gone by year 30 | `tests/sim.test.mjs` |
| Backtest: explicit historical sequence reproduces cumulative home-price growth | `tests/sim.test.mjs` |
| Refinance triggers on a 2-point drop and lowers the payment | `tests/sim.test.mjs` |
| Transforms (Dec/Dec, Q4/Q4, annual averages, ACS rate) against hand-checked values | `tests/test_transforms.py` |
| Offline end-to-end build against synthetic responses | `tests/test_build_offline.py` |
| Committed data.json: completeness, bounds, spot values (2008 S&P −36.55%, 2021 CPI 7.04%) | `tests/test_data_json.py` |

## Known limitations

- **History window.** The window omits earlier cycles (the early-1990s housing decline, 1970s inflation). 2001–2025 includes strong stock returns and a long bond bull market.
- **Rent growth.** It's national, so local rents can diverge.
- **FHFA all-transactions index.** It includes refinance appraisals, which makes it smoother than sales-only indexes. It covers conforming-loan single-family homes.
- **Location data.** Home values and rents are Zillow "typical" (middle-tier) figures, not matched units; enter the rent for a home like the one you'd buy. Property tax and insurance are statewide averages.
- **Not in the model.** Moving costs, renovations, special assessments, refinancing for the ARM, cash-out refinancing, and non-financial value.
