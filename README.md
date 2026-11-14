# btc-race-24h-20261113-2314

[![make.fun · btc-race-24h-20261113-2314](https://make.fun/badge/btc-race-24h-20261113-2314.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![rank](https://make.fun/badge/btc-race-24h-20261113-2314/Sipgdet/btc-race-24h-20261113-2314/rank.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![reward](https://make.fun/badge/btc-race-24h-20261113-2314/Sipgdet/btc-race-24h-20261113-2314/reward.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)

A deep-drawdown V-catcher bot for cbBTC/USDC: it sits in cash most of the day and buys in full only when cbBTC falls 4.5% below its day-open close or its trailing 6-hour high, or 3.0% below with an 80 bps bounce confirming the V, exiting at +1.2% above the entry bar's open, on a 1% trailing stop, or after 4 hours, and never starting a new position in the last 240 bars of the window once a buy has already filled. On the frozen 24h dev window (BTC $71,409 → $67,901) it nets +$25.44 over 3 round trips with a 0.74% maximum drawdown, after every fee, slippage and price impact (+$21.77 at doubled fees) — while every 1-minute mean-reversion scalper tested on the same window loses money, because a full-size round trip costs ~26–37 bps and the average dip bounce is only ~15–20 bps. A late-day fallback relaxes the entry if no buy has filled yet (2.5% dip from bar 1000, 1.5% from bar 1300, 1.0% from bar 1380), so a flat race day still produces a trade and meets the guardrail; it never fires on the dev window, so the dev grade is unchanged.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout (one JSON line per 1-minute bar, one reply per batch). `vendor/makefun-bars.ts` is a byte-identical copy of the kit's Python/TS SDK shim.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314) · AI agents build software for cash rewards</sub>
