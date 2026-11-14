// cbBTC 1-minute bars: a two-leg, single-position system.
//
// Reversal leg: arm on a 30-bar capitulation (close return at or below -90 bps)
// while RSI(14) is below 25; enter when the 15-bar close return reaches +60 bps
// within 60 bars of arming; exit on a 45 bps trailing stop from the peak close,
// or on a +120 bps take-profit measured from the entry bar's close.
//
// Trend leg: enter on a close above the highest close of the prior 240 bars;
// exit on an 80 bps trailing stop from the peak close.
//
// One shared position slot, full size on every entry, at most one order per
// batch. Fully deterministic: float64 indicator math only, no clock, no
// randomness, no environment reads, no state beyond the closes seen so far.
import {
  runBars,
  type BarsState,
  type Batch,
  type OrderInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

const DROP_WINDOW = 30;
const DROP_BPS = -90;
const RSI_SPAN = 14;
const RSI_ARM_MAX = 25;
const ARM_LIFE_BARS = 60;
const CONFIRM_WINDOW = 15;
const CONFIRM_BPS = 60;
const REVERSAL_TRAIL_BPS = 45;
const REVERSAL_TP_BPS = 120;
const TREND_WINDOW = 240;
const TREND_TRAIL_BPS = 80;

const closes: number[] = [];
let gainAcc = 0;
let lossAcc = 0;
let changeCount = 0;
let rsiNow: number | null = null;

let armed = false;
let armedBar = 0;
let openLeg: 'R' | 'T' | null = null;
let trailPeak = 0;
let entryClose = 0;

// Wilder-style RSI: seed with the sums of the first RSI_SPAN moves, then smooth
// with weights 13/14 (RSI_SPAN - 1 over RSI_SPAN). The seed is a sum, not a
// mean, so the first ~50 bars carry a decaying seed transient; that is the
// exact behaviour the thresholds were fitted against, so keep it as-is.
function refreshRsi(nextClose: number, prevClose: number): void {
  const move = nextClose - prevClose;
  const gain = Math.max(0, move);
  const loss = Math.max(0, -move);
  changeCount += 1;
  if (changeCount <= RSI_SPAN) {
    gainAcc += gain;
    lossAcc += loss;
    if (changeCount === RSI_SPAN) {
      rsiNow = 100 - 100 / (1 + (lossAcc === 0 ? 100 : gainAcc / lossAcc));
    }
  } else {
    gainAcc = (gainAcc * 13 + gain) / 14;
    lossAcc = (lossAcc * 13 + loss) / 14;
    rsiNow = 100 - 100 / (1 + (lossAcc === 0 ? 100 : gainAcc / lossAcc));
  }
}

function decide(state: BarsState, close: number): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;
  if (qty > 0n) {
    trailPeak = Math.max(trailPeak, close);
    const trailBps = openLeg === 'T' ? TREND_TRAIL_BPS : REVERSAL_TRAIL_BPS;
    const trailHit = close < trailPeak * (1 - trailBps / 10000);
    const tpHit = openLeg === 'R' && (close / entryClose - 1) * 10000 >= REVERSAL_TP_BPS;
    if (trailHit || tpHit) {
      openLeg = null;
      trailPeak = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }
  const i = closes.length - 1;
  if (i >= DROP_WINDOW && rsiNow !== null) {
    if ((close / closes[i - DROP_WINDOW] - 1) * 10000 <= DROP_BPS && rsiNow < RSI_ARM_MAX) {
      armed = true;
      armedBar = i;
    }
    if (
      armed &&
      i - armedBar <= ARM_LIFE_BARS &&
      i >= CONFIRM_WINDOW &&
      (close / closes[i - CONFIRM_WINDOW] - 1) * 10000 >= CONFIRM_BPS
    ) {
      armed = false;
      trailPeak = close;
      entryClose = close;
      openLeg = 'R';
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    if (armed && i - armedBar > ARM_LIFE_BARS) {
      armed = false;
    }
  }
  if (i >= TREND_WINDOW) {
    let windowMax = -Infinity;
    for (let j = i - TREND_WINDOW; j < i; j += 1) {
      windowMax = Math.max(windowMax, closes[j]);
    }
    if (close > windowMax) {
      trailPeak = close;
      entryClose = close;
      openLeg = 'T';
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
  }
  return [];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    let fresh: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        fresh = Number(bar.c);
      }
    }
    if (fresh === null) {
      return [];
    }
    const prev = closes.length === 0 ? null : closes[closes.length - 1];
    closes.push(fresh);
    if (prev !== null) {
      refreshRsi(fresh, prev);
    }
    // Warmup bars (none in this competition) only seed the indicators; the
    // bot must not trade on them, so skip the decision and answer empty.
    if (state.warmingUp) {
      return [];
    }
    return decide(state, fresh);
  },
});
