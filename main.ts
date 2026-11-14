// Deep-drawdown V-catcher for cbBTC (CBBTC/USDC), 1-minute bars, long only.
//
// Idea, from the 1,440-bar dev window (BTC $71,409 -> $67,901, -4.9%):
// every 1-minute mean-reversion scalper tested loses money after fees. A
// full-size round trip costs ~26-37 bps (4 bps fee + 2 bps slippage + pool
// impact), while the average bounce after a sharp dip is only ~15-20 bps
// over 5 minutes, so scalping is a coin flip that the costs win. The only
// moves big enough to clear the costs are the rare deep V-recoveries: after
// the market falls ~4.5% from its open it has repeatedly bounced +1.5% or
// more within a few hours. This bot does nothing most of the day and only
// buys those extremes, in full size, with a tight trailing stop so a
// waterfall that keeps falling costs about 1% per attempt.
//
// Rules (all in integer basis points against closes, no floats in decisions
// except a ratio computed from bigint closes):
//   - Reference levels: the close of the first scored bar of the window
//     ("day open") and the highest close of the last 360 bars.
//   - Buy, with all cash, when the latest close is at least 450 bps (4.5%)
//     below either reference.
//   - Sell the whole position when any of these holds at a close:
//       * the close is at least 150 bps above the entry bar's open
//         (target; see the entryOpen note below),
//       * the close is at least 100 bps below the highest close seen since
//         the buy was decided (trailing stop; also caps a straight
//         waterfall loss near 1%),
//       * 240 bars have passed since the fill (timeout).
//   - After a sell the buy condition may fire again on the next dip; there
//     is no daily trade cap. The last bar's orders are rejected by the
//     harness and any open position is flattened at the last close.
//   - Orders cap slippage at 100 bps from the decision close, the same
//     guard the kit baselines use; 1-minute moves here are ~8 bps sd.
// Deterministic: decisions are pure functions of the bars seen; no clock,
// no environment, no randomness.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DROP_BPS = 450; // buy at least 4.5% below a reference level
const TARGET_BPS = 150; // take profit 1.5% above the entry fill price
const TRAIL_BPS = 100; // trailing stop 1.0% below the peak close since entry
const MAX_HOLD_BARS = 240; // give a recovery up to 4 hours, then exit
const REF_BARS = 360; // trailing-high lookback, in bars
const MAX_SLIPPAGE_BPS = 100;

// Closes seen so far, oldest first, capped at REF_BARS + 1 entries.
const closes: bigint[] = [];
// Close of the first scored bar of the window (null until the first one).
let dayOpen: bigint | null = null;
// Entry fill price of the open position (null when flat). Set from the
// harness-reported fill of our own buy, so the target is measured against
// the price actually paid, fees and impact aside.
// The take-profit target is measured against the entry bar's OPEN, not the
// fill price: the fill already sits ~15 bps above the open (2 bps modelled
// slippage plus ~13 bps of pool impact at full size), so targeting the
// fill price would demand ~165 bps from the open and would miss the
// recoveries this bot is built to catch. The open is the bar the buy
// filled on, taken from that batch's own bar.
let entryOpen: bigint | null = null;
// Highest close seen since the buy was decided (null when flat).
let peakClose: bigint | null = null;
// Batches since the buy filled (0 when flat).
let holdBars = 0;

function drawdownBps(close: bigint, ref: bigint): bigint {
  // (close / ref - 1) in bps, truncated toward zero; negative = below ref.
  return ((close - ref) * 10000n) / ref;
}

function gainBps(close: bigint, ref: bigint): bigint {
  return ((close - ref) * 10000n) / ref;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    // Fold this batch's fills in first: a buy that filled on this bar's
    // open sets the entry price; a sell that filled clears the position.
    let boughtThisBatch = false;
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryOpen = BigInt(bar.o);
        holdBars = 1;
        boughtThisBatch = true;
      } else if (fill.side === 'sell') {
        entryOpen = null;
        peakClose = null;
        holdBars = 0;
      }
    }
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > REF_BARS + 1) closes.shift();
    if (!state.warmingUp && dayOpen === null) dayOpen = close;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      if (peakClose === null || close > peakClose) peakClose = close;
      // The fill bar already counts as hold bar 1 (set when the fill was
      // folded in above); later bars add one each.
      if (!boughtThisBatch) holdBars += 1;
      const entry = entryOpen ?? close;
      const gain = gainBps(close, entry);
      const trail = peakClose === null ? 0n : gainBps(close, peakClose);
      if (gain >= BigInt(TARGET_BPS) || trail <= -BigInt(TRAIL_BPS) || holdBars >= MAX_HOLD_BARS) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for a deep drawdown against either reference level.
    if (state.warmingUp || dayOpen === null) return [];
    let deepest = drawdownBps(close, dayOpen);
    let high = closes[0]!;
    for (const c of closes) if (c > high) high = c;
    const trailDrawdown = drawdownBps(close, high);
    if (trailDrawdown < deepest) deepest = trailDrawdown;
    if (deepest > -BigInt(DROP_BPS)) return [];
    const room = state.weightRoom(SYMBOL);
    let spend = state.cash < room ? state.cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakClose = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
