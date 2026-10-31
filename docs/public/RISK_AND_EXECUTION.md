# Risk and Execution

This document describes the safety mechanisms around sizing, execution, and position protection. It names mechanisms only. Configuration values are intentionally not documented.

## 1. Risk validation

Every entry must pass a deterministic risk calculation before execution. The calculation:

- Derives position size from a fixed per-trade risk budget.
- Checks that leverage stays within a configured ceiling.
- Checks that margin use for the new position stays within a configured share of equity.
- Rejects plans that fall below the exchange's minimum notional.
- Computes a liquidation guard so that the stop sits clear of the estimated liquidation price.

A plan that fails any check is rejected, and the rejection reason is recorded.

## 2. Account-level controls

- **Margin level guard.** Adds the planned margin to margin already in use and rejects the entry if the combined level exceeds a safety threshold.
- **Daily risk guard.** Stops new entries after a configured daily loss condition.
- **Loss cooldown.** Can pause a symbol after recent losses.
- **Position scope check.** Prevents conflicting exposure on the same symbol.

## 3. ARM execution gate

The ARM state is the operator's switch for allowing orders to reach the exchange.

- When not armed, entries are planned and recorded but never sent.
- The executor refuses any non-reduce-only order when it is not armed.
- Reduce-only exits remain allowed so that open positions can still be closed.
- The default state on startup is not armed. Arming is not performed automatically by normal startup.

## 4. Order handling

- **Idempotency.** Each order has a deterministic client ID. A retried request with the same ID cannot create a second position.
- **Time in force.** Live entries use a post-only setting so they add liquidity and do not cross the book. A rejection due to crossing is treated as a failed entry, not retried as a taker order.
- **Fill verification.** An entry is confirmed by a fill event or a query. Unconfirmed orders are cancelled and recorded.
- **Paper fills.** Simulated fills use recorded prices and an estimated slippage model.

## 5. Stop-loss and take-profit

- **Placement.** Stop and target orders are placed after a fill is verified.
- **Staged exits.** Take-profit is executed in stages. After a configured stage, the stop may be moved to break-even. The exact stages and sizes are not documented.
- **Stop fills.** A stop is treated as filled at its level when price crosses it. A fill beyond the level is accepted only when the candle data proves that the level was crossed without trading there. This prevents a delayed observation from being recorded as a gap fill.
- **Liquidation boundary.** If the authoritative liquidation boundary is crossed, the position is closed as a liquidation-gap event.
- **Exchange synchronization.** When a position is fully closed, remaining protective orders are cancelled and cancellation is verified. Ambiguous orders that do not belong to the closed position are not touched.

## 6. Independent protection

The watchdog process checks the last traded price every second for open positions. When a placed stop or target is touched, it sends a reduce-only market close. This is a second layer that operates when the main server cannot.

## 7. Reconciliation and monitoring

- Startup reconciliation compares stored positions with the exchange.
- A read-only protection monitor raises a critical event if a live position has no active stop on the exchange.
- Metric thresholds generate alerts to the event log.

## 8. Limits of this document

- Exact values for every limit, ratio, and timing constant are configuration and are not published.
- The behavior of experimental strategy paths is not described here.
