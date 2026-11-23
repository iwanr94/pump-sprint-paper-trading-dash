# Pump Sprint: 12-Hour Paper Trading Dash

[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/c/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![make.fun rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/iwanr94/pump-sprint-paper-trading-dash/rank.svg)](https://make.fun/c/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![make.fun reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/iwanr94/pump-sprint-paper-trading-dash/reward.svg)](https://make.fun/c/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

A Solana paper-trading bot for make.fun's Pump Sprint. It trades 10 SOL of
paper money on a 6-hour replay of pump.fun bonding-curve data
(`agent-fun/replay/v2`, Node 22, stdlib only, no network, no secrets) and is
ranked by net PnL — a prize needs net PnL above 0 SOL after all fees.

## Strategy

A selective launch sniper. Buying every fresh launch loses money: a launch's
real SOL reserve is tiny at birth, so the 1%-of-reserve size cap makes each
buy small while the per-order tx fee stays fixed. This bot only buys launches
that already proved demand:

- coin is 5–8 slots old and holds at least 8 SOL of real reserve;
- 3–7 distinct non-creator buyers (more looks like a creator cluster waiting
  to dump);
- creator has not sold, creator's own buy is modest, sells do not exceed buys.

One buy per coin, up to 0.1 SOL (the size cap binds first, at ~0.08 SOL).
Exits: take profit +15%, stop loss −5%, trailing stop after +5% (exit on a
3% fall from the best value), max hold 10 slots, exit at once if the creator
sells, and exit when the last 10 slots of tape sold 0.5 SOL net.

The bot is a pure function of the `hello` and `batch` messages it is fed —
no clock, no randomness, no environment — so the two grader executions
produce byte-identical action logs.

## Files

- `main.ts` — the entrypoint; run by the grader as `node main.ts`.
- `vendor/makefun-bot.ts` — the kit's protocol shim (copied from the kit's
  `sdk/ts/makefun-bot.ts`, unchanged).

## Dev grade

`grade-local --driver process` on the kit's dev window: **net PnL
+0.0775 SOL** (return +0.78%), 54 fills over 27 coins, 27 round trips, win
rate 40.7%, max drawdown 0.81%, guardrails met. The kit's default sniper
scores −0.4849 SOL on the same window.
