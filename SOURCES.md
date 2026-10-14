# Sources

Every number the page uses, where it comes from, and how it's transformed. Generated artifacts:
`data/data.json` (the page's only input), `data/series.lock.json` (resolved FHFA ids), `data/raw/` (cached responses).

## Historical series (resampled)

| Input | Source | Series / table | Transform | Access |
|---|---|---|---|---|
| Home prices, each location | FHFA House Price Index, all-transactions | FRED `ATNHPIUS{CBSA}Q` (per location, see lock file); national `USSTHPI` | Q4 → Q4 % change | FRED API |
| Rent | BLS CPI-U, Rent of primary residence, U.S. city avg, NSA | FRED `CUUR0000SEHA` | % change in calendar-year average (≥10 months required) | FRED API |
| Inflation | BLS CPI-U all items, NSA | FRED `CPIAUCNS` | Dec → Dec % change | FRED API |
| Stocks | Damodaran, NYU Stern — S&P 500 incl. dividends | `data/manual/market_returns.csv` | as published | Manual, updated each January |
| Bonds | Damodaran, NYU Stern — 10-year U.S. Treasury total return | same file | as published | Manual |
| ARM index changes | Federal Reserve H.15, 1-year Treasury CMT | FRED `GS1` | change in annual average, points | FRED API |
| Mortgage-rate changes | Freddie Mac PMMS 30-year fixed | FRED `MORTGAGE30US` | change in annual average, points | FRED API |

## Current values (starting point)

| Input | Source | Series |
|---|---|---|
| 30-year fixed rate | Freddie Mac PMMS | FRED `MORTGAGE30US`, latest week |
| ARM index today | Federal Reserve H.15 | FRED `DGS1`, latest day |
| Home value per location | Zillow Home Value Index (ZHVI), middle tier, smoothed, seasonally adjusted | Zillow Research metro CSV |
| Rent per location | Zillow Observed Rent Index (ZORI), smoothed | Zillow Research metro CSV |
| Property tax rate | U.S. Census Bureau, ACS 1-year, aggregate real estate taxes ÷ aggregate value, owner-occupied | `B25090_001E` / `B25082_001E` by state |
| Home insurance | Freddie Mac Research, "Homeowners insurance costs" (2023 premiums per $1,000 of value) | `config/assumptions.yaml` |
| Agent commissions | Clever Real Estate 2025 survey (5.44%), via HousingWire | `config/assumptions.yaml` |
| Tax law | 2026 standard deduction; SALT cap schedule (P.L. 119-21); $750,000 mortgage-interest limit; IRC §121 | `assets/sim.js` |

## Overrides and judgment calls

| Item | Value | Why |
|---|---|---|
| California property tax | 1.0% | Prop 13 base rate on purchase price. Statewide ACS rates reflect long-held, under-assessed homes. Local levies usually add more. |
| CA / FL assessment caps | 2% / 3% per year | Prop 13; Save Our Homes (needs homestead exemption) |
| Insurance, low states (CA, WA, NV, OR, UT, DC) | 0.25% | Freddie Mac: under $2.50 per $1,000. Upper bound used. |
| Insurance, high states (LA, OK, KS, NE, MS) | 0.80% | Freddie Mac: over $8 per $1,000. Lower bound used. |
| Multi-state metros | average of listed states | e.g. Washington, DC uses VA and MD |
| Everything marked `kind: assumption` | see `config/assumptions.yaml` | Round-number defaults, not data |

## Seed data (until the first pipeline run)

The initial `data/data.json` was assembled by hand from verified sources and is labeled `"source": "seed"`. It differs from pipeline output in three ways:

1. Home prices for 20 metros and the national series use S&P Cotality Case-Shiller (NSA, Dec → Dec, via FRED / DataHub `core/house-prices-us`). Lincoln and Omaha already use FHFA.
2. Mortgage-rate changes use 10-year Treasury annual-average changes as a proxy.
3. Rent uses BLS semiannual averages combined into annual averages.

Running `python -m pipeline.build` replaces all of this with the table above.

## Licenses

See [DATA_LICENSE.md](DATA_LICENSE.md).
