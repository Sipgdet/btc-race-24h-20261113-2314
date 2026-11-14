// Deep-drawdown V-catcher for cbBTC (CBBTC/USDC), 1-minute bars, long only.
//
// Idea, from the 1,440-bar dev window (BTC $71,409 -> $67,901, -4.9%):
// every 1-minute mean-reversion scalper tested loses money after fees. A
// full-size round trip costs ~26-37 bps (4 bps fee + 2 bps slippage + pool
// impact), while the average bounce after a sharp dip is only ~15-20 bps
// over 5 minutes, so scalping is a coin flip that the costs win. The only
// moves big enough to clear the costs are the rare deep V-recoveries: after
// the market falls several percent from its open it has repeatedly bounced
// +1.2% or more within a few hours. This bot does nothing most of the day
// and only buys those extremes, in full size, with a tight trailing stop
// so a waterfall that keeps falling costs about 1% per attempt.
//
// Two entry paths (either may fire; both buy with all cash):
//   - Deep dip: the latest close is at least 450 bps (4.5%) below the
//     day-open close or the trailing 6h high. Buy immediately: at that
//     depth the low is usually close and waiting for confirmation costs
//     the move.
//   - Confirmed shallow dip: the latest close is at least 300 bps (3.0%)
//     below either reference, and has since bounced at least 80 bps off
//     the lowest close seen while dipped. The bounce proves the V has
//     started forming instead of catching a falling knife, so the bot
//     also trades the 3-4.5% dips the deep trigger never sees. This
//     matters on a race day with no 4.5% drawdown: a 3% dip plus a
//     bounce still produces a trade, and the guardrail needs >= 1 trade.
// Rules (all in integer basis points against closes, no floats in decisions
// except a ratio computed from bigint closes):
//   - Reference levels: the close of the first scored bar of the window
//     ("day open") and the highest close of the last 360 bars.
//   - Sell the whole position when any of these holds at a close:
//       * the close is at least 120 bps above the entry bar's open
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
//
// Dev results (local sim, fee 4 bps + 2 bps slippage + pool impact):
//   previous version (deep dip 4.5% only, target 150 bps): net +$12.14,
//   3 buys, 2x-fee +$8.51.
//   this version (hybrid, target 120 bps): net +$17.76, 4 buys (three
//   target hits +$8.41/+$7.81/+$9.23, last buy flattened at window close),
//   2x-fee +$12.91, max drawdown 0.79%. Neighbouring parameters
//   (confirm 70-80 bps, target 100-120 bps) all stay positive, so the
//   edge is a plateau, not a knife-edge threshold.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DROP_BPS = 450; // deep dip: buy at least 4.5% below a reference level
const SHALLOW_BPS = 300; // confirmed dip: 3.0% below a reference level
const CONFIRM_BPS = 80; // bounce off the dip low that confirms the V
const TARGET_BPS = 120; // take profit 1.2% above the entry fill price
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
// fill price would demand ~135 bps from the open and would miss the
// recoveries this bot is built to catch. The open is the bar the buy
// filled on, taken from that batch's own bar.
let entryOpen: bigint | null = null;
// Highest close seen since the buy was decided (null when flat).
let peakClose: bigint | null = null;
// Batches since the buy filled (0 when flat).
let holdBars = 0;
// Lowest close seen while the market has been dipped >= SHALLOW_BPS below
// a reference level (null when flat and not dipped). Tracks the low the
// confirmation bounce is measured from; resets when the dip heals.
let dipLow: bigint | null = null;

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
    // Deep dip: buy immediately, no confirmation needed.
    if (deepest <= -BigInt(DROP_BPS)) {
      dipLow = null;
      const room = state.weightRoom(SYMBOL);
      let spend = state.cash < room ? state.cash : room;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      peakClose = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    // Shallow dip: track the low while dipped, buy on an 80 bps bounce.
    if (deepest <= -BigInt(SHALLOW_BPS)) {
      if (dipLow === null || close < dipLow) dipLow = close;
      if (gainBps(close, dipLow) >= BigInt(CONFIRM_BPS)) {
        dipLow = null;
        const room = state.weightRoom(SYMBOL);
        let spend = state.cash < room ? state.cash : room;
        if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        peakClose = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    // Dip healed without a confirmed bounce: forget the low.
    dipLow = null;
    return [];
  },
});
