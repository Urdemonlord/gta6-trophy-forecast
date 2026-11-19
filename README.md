# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Urdemonlord/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Urdemonlord/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every GTA VI PlayStation 5 trophy's earn rate on Exophase at
2026-11-26T00:00:00Z, built for [make.fun's
`gta6-trophy-rarity-forecast-01` bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
($250 in USDC).

## Model

Earn rates fall as the player base grows: the first buyers are the
hardcore, and each new wave of casual players dilutes the denominator
faster than it earns. Launch night shows it plainly — 638 players
tracked at 23:50Z, 3,868 by 04:30Z, every rate but the one at 100%
lower, the platinum's earners stuck at 4 while the base grew sixfold.

So the program models the dilution instead of copying the last read
(the house baseline's persistence, which scores ~1.51 on the practice):

- Per trophy, the earned count grows as a power of the player base,
  `E ~ N^gamma`, gamma below 1, fitted per trophy from the case
  history's distinct states (reads Exophase actually refreshed) and
  shrunk toward the pooled median gamma (0.12; bronze 0.14, gold 0.07,
  silver and platinum ~0).
- The player base is forecast by a power law in time,
  `ln N = c + d*ln(1+hours)`; on a flat history a refresh mixture
  stands in (a refresh lands before the target with probability
  `1-exp(-horizon/cadence)`, multiplying N by the one observed jump).
- The spread is honest about the refresh: N(T) uncertainty, gamma
  uncertainty, and half of one refresh jump in logit units, because the
  answer sits at the last refresh before the target.

## Validation

- Practice cases p00/p01, scored against the 04:30Z refresh read off
  the public Exophase page (the page still showed those rates at
  11:32 UTC, so both answers are that read): **pinball loss 0.6912**
  vs the house baseline's 1.5084, 90% coverage 0.98 vs 0.00, typical
  miss 0.42 points vs 0.68.
- The practice histories are flat (all reads identical), so a
  time-split inside them is degenerate; the practice score itself is
  the out-of-sample test (fit on the launch-night state, tested on the
  refresh). A synthetic three-state case exercises the fitted path
  (power-law N growth + per-trophy gamma) and stays valid.
- Outputs are deterministic (two runs byte-identical) and run in
  ~1 s per case, well under the 8 s cap.

## Layout

- `main.ts` — the forecaster. Node 22, stdlib only, no network.
  Reads every `*.in` in `$MAKEFUN_INPUT_DIR` (else `/input`),
  writes one `*.out` per case to `$MAKEFUN_OUTPUT_DIR` (else
  `/output`): `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`.

## Reproduce

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT. See LICENSE.
