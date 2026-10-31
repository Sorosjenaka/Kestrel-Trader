# Trading Pipeline

This document lists each pipeline stage, its input and output, and the branches where a candidate is rejected or where execution fails. The Mermaid diagram is in [diagrams/trading-pipeline.md](diagrams/trading-pipeline.md).

## Stage table

| # | Stage | Input | Output | Rejection or failure branch |
|---|---|---|---|---|
| 1 | Market data | Exchange REST and WebSocket feeds | Normalized candles and mark prices | Stale or missing data: symbol skipped |
| 2 | Data processing | Raw candles and prices | Timeframe-aligned series, time-stamp guard | Out-of-order or invalid bars dropped |
| 3 | Market analysis | Series for the universe | Regime, structure, trend, macro state | Insufficient history: symbol not scored |
| 4 | Candidate generation | Analysis output | Scored setup candidates | Below minimum score: discarded |
| 5 | Strategy evaluation | Candidates | Entry reference, invalidation, target attributes | Strategy-specific gate fails: discarded |
| 6 | Decision validation | Candidates with attributes | Judge verdict | Judge reject or timeout (LIVE): discarded |
| 7 | Risk management | Approved candidate | Order plan or rejection | Limit violation: rejected with reason |
| 8 | Council review | Plan that passed risk and judge | Approval or rejection | Timeout, error, or missing vote: rejected |
| 9 | Risk officer | Complete plan | Approval or veto | Veto: rejected |
| 10 | Order execution | Approved plan | Entry order or planned entry | Not armed: planned only; executor error: no position |
| 11 | Position management | Open position | Stop, target, and timeout actions | Watchdog covers server outage |
| 12 | Trade monitoring | Price ticks, exchange events | Exit events, fills | Unverified fill: not counted |
| 13 | Exit management | Exit trigger | Closed position with reason | Exchange rejection: retried or escalated as an event |
| 14 | Reconciliation | Stored state, exchange snapshot | Consistent state or orphan event | Mismatch: logged for review |
| 15 | Performance recording | Closed trade | Post-mortem and statistics | Missing data: recorded as incomplete |

## Conditional branches

- **Not armed.** Stages 1 to 9 run as normal. Stage 10 records a planned entry and sends nothing to the exchange.
- **Paper mode.** Stage 10 uses a simulated executor. The same decision records are produced.
- **LLM unavailable.** Stages 6 and 9 behave according to the mode (see [WORKFLOW.md](WORKFLOW.md)).
- **Server restart.** Stage 14 runs before new entries are evaluated.

## Stages not fully traced

- The exact handling of every strategy-specific gate was not enumerated in this document. Each strategy is evaluated by its own module.
