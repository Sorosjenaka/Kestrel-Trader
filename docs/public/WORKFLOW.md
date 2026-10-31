# Workflow

This document describes the two repeating cycles that drive the system, and the full trade lifecycle from signal to learning. Sequence diagrams and flowcharts are in [diagrams/](diagrams/).

## 1. Scan cycle

The scanner runs on a fixed cadence per mode. Each cycle:

1. The universe manager supplies the current tradeable symbols.
2. Market data is read from the REST pool and WebSocket caches. A symbol with stale data is skipped for this cycle.
3. Each symbol passes through the signal engines and receives a score.
4. Candidates are sorted and the strongest ones are kept for the entry funnel.
5. The scan view is published. Only a completed cycle is visible to the entry logic.

A cycle that exceeds its time limit is abandoned, and the previous complete view remains in use until a new one completes.

## 2. Entry funnel

Entry evaluation runs on its own cycle and reads the latest complete scan view. Candidates pass in order. Each stage can reject the candidate, and each rejection is written to the decision log with its reason.

1. **Daily risk guard.** If the daily guard is tripped, no entries are evaluated.
2. **Arm check.** If the system is not armed, the candidate is planned and recorded, but no order is sent.
3. **Slot and progressive policy.** Open-position capacity and the current progression level limit how many candidates reach review.
4. **Deterministic eligibility.** Volatility, choppiness, and trend-quality checks are applied again at entry time.
5. **Macro gate.** Candidates that conflict with the macro state are rejected.
6. **Setup judge.** The LLM-backed judge returns a verdict. A reject ends the candidate.
7. **Order plan.** The risk engine calculates size, leverage, stop, and target. A plan that violates a limit is rejected.
8. **Margin guard.** Account-level margin usage must stay under a limit after the new position.
9. **Pre-entry council.** Three review roles vote. Any failure to reach approval rejects the candidate.
10. **Risk officer.** The final LLM-backed review of the complete plan can veto.
11. **Execution.** The executor places the entry (or records a planned entry when not armed).

A candidate that clears every stage becomes an open position. Stages 6, 9, and 10 use language models and are the only stages that depend on external AI services.

## 3. Position lifecycle

```
planned or submitted
   -> entry confirmed (fill verified)
   -> open and monitored (price ticks + watchdog)
   -> partial exit(s) at targets, stop moved to break-even where configured
   -> fully closed (stop, target, timeout, funding, trend flip, or liquidation boundary)
   -> reconciled with exchange state
   -> post-mortem recorded
```

### 3.1 Entry

- The executor sends an order with a deterministic client ID. Retries reuse the same ID.
- The entry is verified by a fill event on the WebSocket or a REST query. Until verified, the position is not counted as open.
- Protective stop and target orders are placed for the verified position.

### 3.2 Monitoring

- The supervisor evaluates every open position on each price tick.
- The watchdog independently watches the last traded price against the placed stop and target levels.
- If the server is down, the watchdog continues to enforce protective exits.

### 3.3 Exit

- Each exit path writes a close reason and accounting record.
- When a position is fully closed, a hook cancels the remaining protective orders on the exchange and verifies cancellation.
- Cancellation is idempotent. Ambiguous ownership leaves orders untouched.

### 3.4 Reconciliation

- At startup, stored positions are compared with the exchange snapshot.
- Orphan exchange positions are recorded as events for operator review.
- Paper positions are kept as simulated.

### 3.5 Learning

- A post-mortem evaluator records the outcome of each closed trade.
- Statistics are grouped per setup and per exit reason.
- A tuner may propose parameter versions. A version becomes active only after the replay gate accepts it.

## 4. Failure handling summary

| Situation | Behavior |
|---|---|
| Exchange REST error | Host rotation and retry; client errors are not retried |
| Stale price data | Symbol quarantined until fresh data arrives |
| LLM unavailable in LIVE mode | Candidate is not entered |
| LLM unavailable in PAPER mode | Deterministic fallback verdict, labeled as fallback |
| Council timeout or error | Candidate rejected |
| Order sent without ARM | Refused by the executor |
| Server restart with open positions | Reconciliation before new entries |
| Server down with open positions | Watchdog continues stop and target enforcement |
| Unverified fill | Position not counted as open |
