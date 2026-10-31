# Trading Pipeline Diagram

Shows the full pipeline from market data to performance recording, including rejection branches.

```mermaid
flowchart TD
    A[Market data] --> B[Data processing]
    B --> C[Market analysis]
    C --> D[Candidate generation]
    D -->|below minimum score| X1([Discarded])
    D --> E[Strategy evaluation]
    E -->|gate fails| X2([Discarded])
    E --> F[Decision validation]
    F -->|judge rejects| X3([Discarded])
    F --> G[Risk management]
    G -->|limit violated| X4([Rejected with reason])
    G --> H[Council review]
    H -->|no approval| X5([Rejected])
    H --> I[Risk officer]
    I -->|veto| X6([Rejected])
    I --> J{Armed?}
    J -->|no| K[[Planned entry recorded, no order]]
    J -->|yes| L[Order execution]
    L -->|executor error| X7([No position])
    L --> M[Fill verified]
    M -->|not verified| X8([Not counted as open])
    M --> N[Position management]
    N --> O[Trade monitoring]
    O --> P[Exit management]
    P --> Q[Trade reconciliation]
    Q --> R[Performance recording]
    W[[Watchdog]] -.->|covers outages| O

    classDef reject fill:#fee2e2,stroke:#b91c1c,color:#450a0a
    classDef stop fill:#f1f5f9,stroke:#475569,color:#0f172a
    class X1,X2,X3,X4,X5,X6,X7,X8 reject
    class K stop
```

## Reading the diagram

- Each rejection is recorded with its reason. A rejected candidate does not reach execution.
- The **Armed?** check is the boundary between planning and sending. Without ARM, the pipeline ends at a planned entry.
- Trade monitoring is continuous; the diagram shows it as a single step for readability.
- The dashed watchdog link is an independent path for protective exits.
