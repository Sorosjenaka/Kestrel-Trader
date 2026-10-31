# Decision-Making Flowchart

Shows which information enters the decision layer, how each check is applied, and when a candidate is rejected.

```mermaid
flowchart TD
    IN[[Inputs: candidate score, regime,<br/>zones, trend, KNN estimate, macro state]] --> G0{Daily guard<br/>and arm state}
    G0 -->|tripped| R0([Reject: entries paused])
    G0 -->|ok| G1{Deterministic<br/>eligibility}
    G1 -->|fails| R1([Reject])
    G1 -->|passes| G2{Macro gate}
    G2 -->|conflicts| R2([Reject])
    G2 -->|passes| J{Setup judge}
    J -->|reject or unavailable in LIVE| R3([Reject])
    J -->|approve| P[Order plan:<br/>size, leverage, stop, target]
    P --> G3{Risk limits<br/>and margin guard}
    G3 -->|violated| R4([Reject])
    G3 -->|passes| C{Pre-entry council<br/>three votes}
    C -->|any failure, timeout or error| R5([Reject])
    C -->|approve| O{Risk officer}
    O -->|veto| R6([Reject])
    O -->|approve| EX([Proceed to execution])

    classDef reject fill:#fee2e2,stroke:#b91c1c,color:#450a0a
    classDef ok fill:#dcfce7,stroke:#15803d,color:#052e16
    classDef llm fill:#fef3c7,stroke:#b45309,color:#451a03
    class R0,R1,R2,R3,R4,R5,R6 reject
    class EX ok
    class J,C,O llm
```

## Reading the diagram

- **Amber** diamonds are LLM-backed decisions. The council is fail-closed: missing, late, or errored votes count as rejection.
- Every rejection is recorded with the stage that produced it.
- Only a candidate that clears all checks reaches execution.
- The thresholds used in the checks are configuration and are not shown.
