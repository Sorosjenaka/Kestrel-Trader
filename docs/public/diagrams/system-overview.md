# System Overview Diagram

Shows the main components, the external services they depend on, and the direction of data flow.

```mermaid
flowchart LR
    subgraph EXT[External services]
        BIN[(Binance USD-M<br/>REST + WebSocket)]
        LLM[(LLM provider)]
    end

    subgraph MD[Market data]
        UNI[Universe manager]
        RP[REST pool]
        WS[WebSocket managers]
    end

    subgraph SIG[Analysis]
        SCAN[Scanner]
        ENG[Signal engines]
    end

    subgraph DEC[Decision]
        JUDGE[Setup judge]
        COUNC[Pre-entry council]
        RISKO[Risk officer]
    end

    subgraph RISK[Risk and execution]
        RE[Risk engine]
        EXE[Executor]
        ARM{{ARM gate}}
    end

    subgraph POS[Position management]
        SUP[Supervisor]
        WD[[Watchdog process]]
    end

    subgraph STORE[Persistence and learning]
        DB[(SQLite via Prisma)]
        LEARN[Learning loop]
    end

    DASH[Dashboard]

    BIN --> RP
    BIN --> WS
    UNI --> SCAN
    RP --> SCAN
    WS --> SCAN
    SCAN --> ENG
    ENG --> JUDGE
    JUDGE --> LLM
    JUDGE --> RE
    RE --> COUNC
    COUNC --> RISKO
    RISKO --> EXE
    EXE --> ARM
    ARM -->|armed| BIN
    EXE --> SUP
    SUP --> BIN
    WS --> WD
    WD --> BIN
    SUP --> DB
    EXE --> DB
    DB --> LEARN
    DB --> DASH
    DASH -.->|operator actions| DB

    classDef ext fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b
    classDef gate fill:#fef3c7,stroke:#b45309,color:#451a03
    classDef risk fill:#dcfce7,stroke:#15803d,color:#052e16
    classDef exec fill:#fee2e2,stroke:#b91c1c,color:#450a0a
    class BIN,LLM ext
    class JUDGE,COUNC,RISKO gate
    class RE risk
    class EXE,ARM,WD exec
```

## Reading the diagram

- **Blue** nodes are external services.
- **Amber** nodes are decision steps that may use an LLM.
- **Green** is the deterministic risk step.
- **Red** nodes are the execution path. Orders reach the exchange only through the ARM gate.
- The **watchdog** reads the same price stream as the scanner and sends protective closes directly, so it does not depend on the server.
- Dashed arrows are operator actions, not automated flow.
