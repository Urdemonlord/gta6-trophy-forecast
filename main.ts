// GTA VI trophy rarity forecaster (gta6-trophy-rarity-forecast-01).
//
// The model: earn rates fall as the player base grows, because the first
// buyers are the hardcore and every new wave of casual players dilutes the
// denominator faster than it earns. The one refresh Exophase made on launch
// night shows it plainly: 638 players tracked at 23:50Z, 3,868 by 04:30Z,
// and every rate but the one at 100% lower, the platinum's earners stuck
// at 4 while the base grew sixfold. So the forecast models the dilution,
// it does not copy the last read the way the house baseline does.
//
// Per trophy, the earned count grows as a power of the player base,
// E ~ N^gamma, with gamma below 1 (sublinear: the rate E/N falls as N
// grows). gamma is fitted per trophy from the case history's distinct
// states (reads Exophase actually refreshed, identical consecutive reads
// collapsed), shrunk toward a pooled gamma; where the history is flat the
// tier priors below stand in. The player base itself is forecast by a
// power law in time, ln N = c + d*ln(1+hours), fitted on the same states;
// where the history is flat, a refresh mixture stands in: a refresh lands
// before the target with probability 1-exp(-horizon/cadence) and, when it
// does, multiplies N by the one observed jump.
//
// The spread is honest about the refresh: it combines the uncertainty in
// N at the target, the uncertainty in gamma, and half of one refresh jump
// in logit units, because the answer is the page at the last refresh
// before the target and that refresh can fall anywhere in the window.
// Quantiles are the median's logit plus the standard normal's quantile
// times that spread, mapped back to percent.
//
// Priors, from the launch-night refresh (638 -> 3,868 players, rates
// read off the public Exophase page at 11:32 UTC on 19 Nov 2026):
// pooled gamma 0.12 (bronze 0.14, gold 0.07, silver and platinum ~0:
// the hard trophies' earners barely moved while the base grew sixfold).
// The program itself reads only the case file at run time; these numbers
// are fixed constants, never tuned per case.
//
// Runs on Node 22, standard library only, no network, deterministic:
// the same case file always produces the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Prior gamma (earned counts grow as N^gamma) per tier, from the launch-night refresh. */
const GAMMA_PRIOR: Record<string, number> = { platinum: 0.02, gold: 0.07, silver: 0.02, bronze: 0.14 };
/** Pooled gamma prior, same source. */
const GAMMA_POOL = 0.12;
/** Mean time between Exophase refreshes, hours (one seen ~4.7h after the first read, then none for 7h). */
const CADENCE_H = 6.0;
/** The player-base multiplier at the one observed refresh. */
const JUMP_PRIOR = 6.06;
/** Power-law growth exponent prior for ln N against ln(1+hours). */
const D_PRIOR = 0.8;

interface Trophy {
  id: number;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  levels: number[];
  horizon_minutes: number;
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Least squares line through (xs, ys); null when xs do not vary. */
function ols(xs: number[], ys: number[]): { a: number; b: number; residSd: number } | null {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, residSd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

/** Two reads are the same page state when the base and every rate match. */
function sameState(r: Read, s: Read): boolean {
  if (r.players_tracked !== s.players_tracked) return false;
  if (r.rates.length !== s.rates.length) return false;
  for (let i = 0; i < r.rates.length; i++) if (r.rates[i] !== s.rates[i]) return false;
  return true;
}

function forecast(c: Case): Array<{ id: number; q: number[] }> {
  const n = c.trophies.length;
  const horizonH = c.horizon_minutes / 60;

  // No history cannot happen per the schema; still emit a valid forecast.
  if (c.history.length === 0) {
    return c.trophies.map((t) => ({ id: t.id, q: [0.2, 0.5, 1.0, 2.0, 5.0] }));
  }

  // Collapse consecutive identical reads: only a refresh carries new information.
  const states: Read[] = [];
  for (const r of c.history) {
    if (states.length === 0 || !sameState(r, states[states.length - 1])) states.push(r);
  }
  const k = states.length;
  const t0 = Date.parse(c.history[0].at);
  const hours = (iso: string): number => (Date.parse(iso) - t0) / 3_600_000;
  const stateH = states.map((r) => hours(r.at));
  const targetH = stateH[stateH.length - 1] + horizonH;
  const Ns = states.map((r) => r.players_tracked);
  const nLast = Ns[Ns.length - 1];

  // Earned counts per trophy per state, carrying the last known rate over
  // a read that lacked the trophy; 0.5 stands in for "nobody yet" so the
  // log stays finite.
  const earned: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    let last = 0.5;
    for (const r of states) {
      const rate = r.rates[i];
      if (rate !== null && rate !== undefined) last = Math.max((rate * r.players_tracked) / 100, 0.5);
      row.push(last);
    }
    earned.push(row);
  }

  // --- Forecast the player base at the target. ---
  let muLnN: number;
  let sigLnN: number;
  let jumpTyp: number;
  if (k >= 2) {
    const xs = stateH.map((h) => Math.log(1 + h));
    const ys = Ns.map((v) => Math.log(v));
    const fit = ols(xs, ys);
    let d = D_PRIOR;
    let resid = 0.3;
    if (fit !== null) {
      d = fit.b;
      resid = fit.residSd;
    }
    const w = Math.min(1, k / 6);
    d = w * d + (1 - w) * D_PRIOR;
    const a = Math.log(nLast) - d * Math.log(1 + stateH[stateH.length - 1]);
    muLnN = a + d * Math.log(1 + targetH);
    sigLnN = Math.max(0.35, resid + 0.15 * Math.sqrt(horizonH / 24));
    jumpTyp = Math.exp(muLnN) / nLast;
  } else {
    // Flat history: the page has not refreshed since the first read, so a
    // refresh may land before the target. Weight the jump by that chance.
    const w = Math.min(0.85, 1 - Math.exp(-horizonH / CADENCE_H));
    muLnN = Math.log(nLast) + w * Math.log(JUMP_PRIOR);
    sigLnN = 0.55 + 0.25 * w;
    jumpTyp = JUMP_PRIOR;
  }
  const nT = Math.exp(muLnN);

  // --- Pooled gamma: the median of the per-trophy slopes, not the slope
  // of the total earned. The total is dominated by the common trophies
  // (the 100% one grows with N, gamma 1), while the typical rare trophy
  // dilutes hard (gamma ~0.1); pooling on the total would pull every rare
  // trophy's gamma up toward 1 and understate the dilution.
  const slopes: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    const universalI = states.every((r) => {
      const rate = r.rates[i];
      return rate !== null && rate !== undefined && rate >= 99.99;
    });
    if (universalI || k < 2) {
      slopes.push(null);
      continue;
    }
    const fit = ols(Ns.map((v) => Math.log(v)), earned[i].map((e) => Math.log(e)));
    slopes.push(fit === null ? null : Math.max(-0.1, Math.min(1, fit.b)));
  }
  let gammaPool = GAMMA_POOL;
  const usable = slopes.filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (usable.length > 0) gammaPool = usable[Math.floor(usable.length / 2)];

  // --- Per trophy: median rate and spread. ---
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < n; i++) {
    const t = c.trophies[i];
    const universal = states.every((r) => {
      const rate = r.rates[i];
      return rate !== null && rate !== undefined && rate >= 99.99;
    });
    if (universal) {
      // Earned by everyone in every read: it stays at the top.
      rows.push({ id: t.id, q: [99.9, 99.95, 99.99, 99.99, 99.99] });
      continue;
    }
    let gamma = GAMMA_PRIOR[t.tier] ?? GAMMA_POOL;
    let sigGamma = 0.15;
    if (k >= 3 && slopes[i] !== null) {
      const b = slopes[i] as number;
      const fit = ols(Ns.map((v) => Math.log(v)), earned[i].map((e) => Math.log(e)));
      const wFit = Math.min(0.8, k / 8 + (Math.max(...earned[i]) > 20 ? 0.3 : 0));
      gamma = Math.max(-0.1, Math.min(1, wFit * b + (1 - wFit) * gammaPool));
      sigGamma = Math.max(0.12, fit === null ? 0.15 : fit.residSd);
    } else if (k === 2 && slopes[i] !== null) {
      const e0 = earned[i][0];
      const e1 = earned[i][1];
      if (Ns[1] !== Ns[0]) {
        const b = (Math.log(e1) - Math.log(e0)) / (Math.log(Ns[1]) - Math.log(Ns[0]));
        gamma = Math.max(-0.1, Math.min(1, 0.35 * b + 0.65 * gammaPool));
        sigGamma = 0.2;
      }
    }
    // Median: the earned count follows its power law to N(T), the rate is that over N(T).
    const eLast = earned[i][earned[i].length - 1];
    const rT = clamp((eLast * (nT / nLast) ** gamma) / nT * 100);
    // Spread in logit units: N(T) uncertainty, gamma uncertainty, and half
    // of one refresh jump, because the answer sits at the last refresh
    // before the target and that jump can fall anywhere in the window.
    const sN = Math.abs(gamma - 1) * sigLnN;
    const sG = Math.abs(Math.log(Math.max(nT / nLast, 1e-9))) * sigGamma;
    const sStep = 0.5 * Math.abs(gamma - 1) * Math.log(Math.max(jumpTyp, 1.01));
    const s = Math.min(2.0, Math.max(0.4, Math.sqrt(sN * sN + sG * sG + sStep * sStep + 0.3 * 0.3)));
    const l = logit(rT);
    const q = Z.map((z) => round4(clamp(invLogit(l + z * s))));
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    rows.push({ id: t.id, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecast(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
