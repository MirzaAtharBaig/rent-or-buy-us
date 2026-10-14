# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [1.1.0] - 2026-10-14
### Added
- Reproducible data pipeline (`pipeline/`) building `data/data.json` from FRED, the Census API and Zillow Research, with on-disk cache and `--offline` mode.
- Home prices for every location from the FHFA all-transactions index; location list driven by `config/metros.yaml`.
- Refinance rule for the fixed-rate owner (trigger, cost, rate path from Freddie Mac PMMS changes).
- Kansas City, MO-KS (appears after the first pipeline run).
- Tests: engine (node:test), transforms, offline end-to-end build, data.json checks. CI on every push; monthly data refresh workflow.
- METHODOLOGY.md, SOURCES.md, DATA_LICENSE.md, CITATION.cff.
### Changed
- Split the single HTML file into `index.html`, `assets/*.js`, `assets/styles.css`, `data/data.json`.
- Defaults read from `config/assumptions.yaml`; each is labeled sourced or assumption.

## [1.0.0] - 2026-10-14
### Added
- Initial single-file simulator: 21 locations (20 Case-Shiller metros plus national), Lincoln and Omaha (FHFA), custom location, 1,000-future block bootstrap, fixed / ARM / rent paths, federal tax effects.
