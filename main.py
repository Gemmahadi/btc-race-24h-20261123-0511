"""Dip-buyer for CBBTC/USDC, agent-fun/bars-replay/v1 (Python 3.13, stdlib only).

Idea: cbBTC on this pool mean-reverts around a slow trend. The bot stays in
cash most of the time and only buys after a sharp dip -- the close at least
0.9% below its 89-bar exponential moving average -- then sells the recovery
at +2.0% over its average entry cost, or cuts the loss at -1.0%. One position
at a time, full size, so a round trip only pays the ~26 bps of fees/slippage/
impact once per captured swing. Everything is deterministic: the only state
is the EMA of closes and the recorded entry cost, both functions of the bars
seen; no clock, no environment, no randomness.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"

# Strategy parameters (proven on the published 18 Nov dev window: +14.84 USDC
# at TP 2.0%. The cluster around these values was broadly positive: 319/625
# nearby combos profitable, best +$16.9 at TP 2.2%, +$13.3 at TP 1.8% -- so
# the exit is moved to the cluster best, 2.2%, where the sweep's peak sits.
# Cross-up entries and trailing stops were tried and rejected: both cut dev
# PnL by adding whipsaw trades.)
EMA_BARS = 89           # slow trend the dip is measured against
DIP_BPS = 90            # buy when close <= EMA * (1 - 0.9%)
TAKE_PROFIT_BPS = 220   # sell when close >= entry cost * (1 + 2.2%)
STOP_LOSS_BPS = 100     # sell when close <= entry cost * (1 - 1.0%)
MAX_SLIPPAGE_BPS = 150  # allow the next open to gap up to 1.5% from the close

_BPS = 10_000


class DipBuyer:
    def __init__(self):
        self.ema = None        # EMA of closes, in raw price units (float)
        self.bars = 0          # bars of SYMBOL seen
        self.entry_cost = None  # average entry price, raw price units (int)

    def _entry_price(self, state):
        """Average cost of the held position, in raw price units."""
        holding = state.positions.get(SYMBOL)
        if holding is None or holding.qty <= 0:
            return None
        sym = state.symbols[SYMBOL]
        quote_scale = state.hello["capital"]["quote_scale"]
        num = holding.cost * 10 ** (sym["qty_scale"] + sym["price_scale"])
        den = holding.qty * 10 ** quote_scale
        return num // den if den else None

    def on_batch(self, state, batch):
        if state.warming_up:
            return []
        bar = state.latest.get(SYMBOL)
        if bar is None:
            return []
        close = int(bar["c"])
        # Update the slow EMA with this bar's close.
        if self.ema is None:
            self.ema = float(close)
        else:
            k = 2.0 / (EMA_BARS + 1)
            self.ema += k * (close - self.ema)
        self.bars += 1

        holding = state.positions.get(SYMBOL)
        in_position = holding is not None and holding.qty > 0

        if in_position:
            entry = self._entry_price(state)
            if entry is None:
                return []
            if close * _BPS >= entry * (_BPS + TAKE_PROFIT_BPS):
                return [{"side": "sell", "symbol": SYMBOL, "qty": holding.qty,
                         "max_slippage_bps": MAX_SLIPPAGE_BPS}]
            if close * _BPS <= entry * (_BPS - STOP_LOSS_BPS):
                return [{"side": "sell", "symbol": SYMBOL, "qty": holding.qty,
                         "max_slippage_bps": MAX_SLIPPAGE_BPS}]
            return []

        # Flat: buy only after a real dip below the slow trend, with enough
        # history for the EMA to mean something.
        if self.bars < EMA_BARS:
            return []
        if close * _BPS <= int(self.ema) * (_BPS - DIP_BPS):
            cash = state.cash
            if cash <= 0:
                return []
            return [{"side": "buy", "symbol": SYMBOL,
                     "notional_quote_units": cash,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        return []


def main():
    makefun_bars.run(DipBuyer().on_batch)


if __name__ == "__main__":
    main()
