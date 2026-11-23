// Buy-early, hold-the-drift rider for CBBTC/USDC, agent-fun/bars-replay/v1
// (Node 22, stdlib + vendor shim).
//
// Lesson from grading v2/v3 on the dev window: this pool's 1-minute closes
// move only ~8 bps (std) and the window trends up +358 bps, so every active
// strategy gives its gains back to the 26 bps round-trip cost. EMA 8/21 cross
// lost -$114.83 on 76 trades, a 25 bps dip-buyer -$14.10 on 22, a 60-bar trend
// rider -$3.02 on 16, a 120-bar one +$0.07 on 7. Buy-and-hold made +$32.17 and
// momentum +$34.94, both on a single trade. This bot is the long-only version
// of that fact: buy on the first sign of positive drift, then HOLD, exiting
// only on a real crash (close 200 bps below the peak since entry, or 200 bps
// under entry cost), with a 60-bar cooldown before any re-entry so a falling
// knife's bounce is never caught. Size is depth-aware (buy shrunk while its
// own impact would exceed ~8 bps). An 8% equity brake stops new entries after
// a drawdown. Deterministic: no clock, no randomness, no environment; every
// decision is a function of the bars seen.

import { BPS, runBars, type BarsState } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const ENTRY_LOOKBACK_BARS = 30; // entry: the return over the last 30 closes
const ENTRY_BPS = 10; // buy when the 30-bar return is at least this (bps)
const TRAIL_BPS = 200n; // sell when the close is this far below the peak since entry
const HARD_STOP_BPS = 200n; // sell when the close is this far under entry cost
const COOLDOWN_BARS = 60; // bars to wait after an exit before re-entering
const MAX_IMPACT_BPS = 50n; // shrink the buy only while its own impact would exceed this:
// at this pool's depth (~550k-1.1M USDC) a full-size buy costs ~11-18 bps,
// trivial next to a 200+ bps trend move, so the cap is a safety valve, not a
// sizing rule (an 8 bps cap halved the position and halved the profit).
const MAX_SLIPPAGE_BPS = 150;
const BRAKE_DRAWDOWN_BPS = 800n;

const closes: bigint[] = [];
let peakSinceEntry: bigint | null = null;
let lastExitSeq = -1000000;
let peakEquity = 0n;

function entryPrice(state: BarsState): bigint | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty <= 0n) return null;
  const s = state.symbols.get(SYMBOL);
  if (s === undefined) return null;
  const qs = BigInt(state.hello.capital.quote_scale);
  return (held.cost * 10n ** BigInt(s.qty_scale + s.price_scale)) / (held.qty * 10n ** qs);
}

function sizeBuy(state: BarsState, cash: bigint): bigint {
  if (cash <= 0n) return 0n;
  let size = cash;
  const imp = state.impactBps(SYMBOL, cash);
  if (imp !== null && imp > 0n && imp > MAX_IMPACT_BPS) {
    size = (cash * MAX_IMPACT_BPS) / imp;
  }
  const room = state.weightRoom(SYMBOL);
  if (size > room) size = room;
  const minN = BigInt(state.hello.fees.min_notional_quote_units);
  return size >= minN ? size : 0n;
}

/** The return over the last ENTRY_LOOKBACK_BARS closes in bps, or null before then. */
function shortTrendBps(): bigint | null {
  if (closes.length < ENTRY_LOOKBACK_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - ENTRY_LOOKBACK_BARS]!;
  if (then <= 0n) return null;
  return ((now - then) * BPS) / then;
}

await runBars({
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    if (state.equity > peakEquity) peakEquity = state.equity;
    closes.push(close);
    if (closes.length > ENTRY_LOOKBACK_BARS) closes.shift();

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      if (peakSinceEntry === null || close > peakSinceEntry) peakSinceEntry = close;
      const entry = entryPrice(state);
      if (entry === null) return [];
      if (
        close * BPS <= entry * (BPS - HARD_STOP_BPS) ||
        (peakSinceEntry !== null && close * BPS <= peakSinceEntry * (BPS - TRAIL_BPS))
      ) {
        lastExitSeq = state.seq;
        peakSinceEntry = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    peakSinceEntry = null;
    if (state.equity * BPS <= peakEquity * (BPS - BRAKE_DRAWDOWN_BPS)) return [];
    if (!batch.bars.some((b) => b.symbol === SYMBOL)) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const trend = shortTrendBps();
    if (trend === null || trend < BigInt(ENTRY_BPS)) return [];
    const size = sizeBuy(state, state.cash);
    if (size <= 0n) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
