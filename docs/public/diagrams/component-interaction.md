# Component Interaction Diagram

Shows which components communicate and how. Line styles encode the mechanism.

```mermaid
flowchart LR
    subgraph EXCH[Exchange and providers]
        REST[(Binance REST)]
        WSX[(Binance WebSocket)]
        LLMP[(LLM provider)]
    end

    subgraph SRV[Server process]
        MDM[Market data managers]
        SC[Scanner]
        DL[Decision layer]
        RSK[Risk engine]
        EX[Executor]
        SP[Supervisor]
        RC[Reconciler]
        LP[Protection monitor]
        LRN[Learning loop]
        API[REST and SSE API]
        DBX[(SQLite)]
    end

    WD[[Watchdog process]]
    UI[Dashboard]

    WSX -->|stream| MDM
    REST <-->|request| MDM
    MDM -->|in-memory cache| SC
    SC -->|scan view| DL
    DL <-->|request| LLMP
    DL -->|call| RSK
    RSK -->|plan| EX
    EX <-->|signed order| REST
    SP -->|exit call| EX
    SP -->|state| DBX
    EX -->|record| DBX
    RC <-->|snapshot| REST
    RC -->|events| DBX
    LP -->|read| REST
    LP -->|events| DBX
    DBX -->|read| LRN
    LRN -->|statistics| DBX
    DBX -->|read| API
    API -->|SSE stream| UI
    UI -->|REST request| API
    WSX -->|price| WD
    WD -->|reduce-only close| REST

    classDef ext fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b
    classDef store fill:#f1f5f9,stroke:#475569,color:#0f172a
    classDef indep fill:#fee2e2,stroke:#b91c1c,color:#450a0a
    class REST,WSX,LLMP ext
    class DBX store
    class WD indep
```

## Legend

| Arrow | Meaning |
|---|---|
| `-->` | One-way data or call |
| `<-->` | Request and response |
| `-->|stream|` | Continuous WebSocket data |
| `-->|SSE stream|` | Server-sent events to the browser |

- **Blue**: external services.
- **Grey**: persistence.
- **Red**: the independent watchdog process, which sends closes without going through the server.
- The watchdog reads the price stream directly. It does not read the server's in-memory state.
