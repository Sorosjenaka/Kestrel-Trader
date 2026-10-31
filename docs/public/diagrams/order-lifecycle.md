# Order Lifecycle Diagram

Shows how an order moves from preparation to cleanup, including partial fills, protective orders, and reconciliation.

```mermaid
stateDiagram-v2
    [*] --> Prepared: plan approved
    Prepared --> Planned: not armed
    Planned --> [*]: recorded, no order sent
    Prepared --> Submitted: armed, entry sent (client ID)
    Submitted --> Acknowledged: exchange accepts
    Submitted --> Failed: rejected or error
    Failed --> [*]
    Acknowledged --> PartiallyFilled: partial fill
    Acknowledged --> Filled: full fill
    PartiallyFilled --> Filled: remaining fill
    PartiallyFilled --> Cancelled: entry cancelled
    Filled --> Verified: fill verified (WS or REST)
    Verified --> Protected: stop and target placed
    Protected --> PartialExit: staged take-profit
    PartialExit --> Protected: remaining size
    Protected --> Closing: stop, target, timeout, funding, trend, or liquidation
    PartialExit --> Closing
    Closing --> Cleanup: position fully closed
    Cleanup --> Reconciled: protective orders cancelled and verified
    Reconciled --> [*]
    Cancelled --> [*]
```

## Reading the diagram

- **Idempotency** holds across the Submitted and Acknowledged states: a retry reuses the same client ID.
- **Partial fills** are tracked until the entry is complete or cancelled.
- **Protected** means a stop is in place. Targets are staged and the stop may move after a configured stage.
- **Cleanup** runs only after a full close. Orders that cannot be attributed to the closed position are left untouched.
- **Reconciled** means the exchange state was confirmed against the database.
