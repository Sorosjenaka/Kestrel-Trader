# Architecture

This document describes each subsystem: what it is, what it receives, what it produces, and what happens when it fails. Diagrams are in [diagrams/system-overview.md](diagrams/system-overview.md) and [diagrams/component-interaction.md](diagrams/component-interaction.md).

## 1. External integrations

| Integration | Used for | Failure behavior |
|---|---|---|
| Binance USD-M REST API | Exchange metadata, candles, account snapshot, order placement and queries | Requests rotate across a pool of hosts. A host with repeated failures is skipped for a cooldown. Client errors are not retried. |
| Binance USD-M WebSocket streams | Mark prices and kline updates | Stale streams trigger reconnection. A symbol whose data is stuck is quarantined until fresh data returns. |
| LLM provider | Setup judge, risk officer, council, and analysis roles | Timeouts and errors are handled per role. The council fails closed (see below). |
| Optional research provider | Additional chart analysis in research paths | Disabled paths do not affect the trading pipeline. |

## 2. Market data layer

**Universe manager.** Periodically fetches the exchange contract list and keeps only perpetual contracts that are USDT-margined and currently trading. The rule is deny-by-default: anything not on the allow rule is excluded. Manual exclusions always take precedence. The result is the universe that the scanner may use. A failed sync keeps the previous universe and logs the failure.

**REST pool.** A single client shared by all components. It rotates hosts, retries with backoff on transient failures, and corrects request timestamps against exchange server time for signed requests. Client errors (except rate-limit and temporary-ban responses) are treated as fatal and are not retried.

**WebSocket managers.** One stream carries mark prices for all symbols. Per-symbol kline streams feed candle data for symbols under evaluation. A gap in the stream causes a resubscribe. A symbol whose price has not updated in time is marked untradeable until data is fresh again.

**Leverage sync and asset class guard.** Periodically refresh per-symbol leverage information and keep the non-crypto exclusion list up to date from the exchange metadata.

## 3. Scanner and signal engines

**Scanner pool.** Runs a bounded number of symbol evaluations in parallel on a fixed cycle, with dedicated cadences for different market horizons. It produces a scan view: the candidates from the latest complete cycle plus cycle metrics. Downstream components read only completed cycles, so a partial scan cannot be traded.

**Signal engines.** Each candidate passes through several deterministic engines:

- **Regime engine:** classifies the market state (trend, range, volatility conditions).
- **Zone and trigger engine:** identifies structural zones (supply/demand and liquidity areas) and whether price is triggering in one.
- **Multi-timeframe analyzer:** confirms that higher and lower timeframes agree.
- **Analog library (KNN):** compares the current feature vector with stored outcomes of similar past setups and returns an estimated probability. It contributes to the score; it is not a standalone signal.
- **Macro gate:** reads the state of the two largest markets (BTC and ETH) and the BTC dominance series. A candidate against a clear macro direction can be blocked.

The output is a scored candidate with direction, entry reference, invalidation level, and supporting attributes. Candidates below the minimum score are dropped.

## 4. Decision layer

**Setup judge.** An LLM-backed role that reviews a candidate and returns a verdict with a reason. If the LLM is unavailable, the system can fall back to a deterministic verdict in PAPER mode and marks it as such. In LIVE mode, an unavailable judge means the candidate is not entered.

**Risk officer.** A second LLM-backed review that runs after the order plan is calculated. It sees the planned stop, target, and size, and can veto the entry.

**Pre-entry council.** Three review roles vote on candidates that have already passed all deterministic gates and the judge. The council is fail-closed: a timeout, error, or missing vote counts as a rejection. It can only prevent an entry and never creates one. Each decision is recorded as an event.

**Analysis roles.** Other roles (market analyst, market intelligence, trade evaluator, and similar) run for reporting and learning. They do not directly place orders.

## 5. Risk engine

A deterministic module that converts an approved candidate into an order plan. It calculates size from a fixed risk budget, enforces leverage and margin limits, checks minimum notional, and computes a liquidation guard. It also checks account-level margin usage before an entry is allowed. Exact limits are configuration, not documented here. See [RISK_AND_EXECUTION.md](RISK_AND_EXECUTION.md) for the mechanisms.

A daily risk guard can stop new entries when a loss limit is reached. A loss cooldown can pause a symbol after losses.

## 6. Executor

Places entry orders with a deterministic client order ID so that a retried request cannot create a duplicate. Before sending to the exchange it checks the ARM state; if not armed and the order is not reduce-only, it refuses the order. Entry orders use a post-only time-in-force when the exchange is live, so they only add liquidity. The executor then verifies the fill through the WebSocket or a REST query. In PAPER mode a simulated executor produces fills using recorded price data and slippage estimates.

## 7. Position supervisor

Monitors each open position on every price tick and applies exit rules:

- Stop-loss, including gap handling that is only accepted when the candle data proves the stop was crossed.
- Take-profit legs, with partial closes and a follow-up move of the stop to break-even after a configured leg.
- Maximum holding time.
- Funding-aware exit checks.
- Trend-reversal exit when a strong opposite trend is confirmed.
- Liquidation-boundary exit.

Each exit writes its reason and accounting to the database. A hook removes protective orders on the exchange once a position is fully closed.

## 8. Watchdog

A separate process that checks the last traded price every second for open positions. When the price touches a stop or target that is placed on the exchange, it sends a reduce-only market close. It runs independently of the main server, so a server outage does not remove protection. It has its own configuration and tests.

## 9. Reconciler and live protection monitor

**Reconciler.** At startup, compares stored open positions with the exchange snapshot. Positions present on the exchange but missing from the database are logged as orphans and are not silently ignored. Paper positions are kept as simulated.

**Live protection monitor.** A read-only loop that raises a critical event when a live position has no active stop-loss on the exchange.

## 10. Learning loop

After a trade closes, a post-mortem evaluator records the outcome and attributes it to the setup, entry attributes, and exit reason. Results feed statistics per setup and a learning-entry store. A strategy tuner can propose new parameter versions. Parameter changes are stored as versioned records. The activation rule (replay validation before a version becomes active) is implemented in the replay gate module; the exact threshold is not documented here.

## 11. Persistence

A SQLite database managed by Prisma holds:

- settings and parameter versions
- candidate setups and decision logs
- positions, orders, trades, and exit accounting
- event logs
- learning entries, playbook rules, and backtest runs
- liquidation and leverage history

## 12. Dashboard

A React single-page application that reads from the server's REST endpoints and from server-sent event streams for live panels. It is for monitoring and operator control. It does not contain trading logic.

## Undocumented or partially verified

- Exact behavior of every research-only strategy path was not traced.
- The complete set of dashboard pages and their data sources was not enumerated individually.
- Watchdog deployment details are intentionally not documented.
