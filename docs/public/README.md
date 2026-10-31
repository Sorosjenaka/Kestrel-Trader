# Kestrel-Trader Public Documentation

Index for the public architecture and workflow documentation of Kestrel-Trader.

This documentation explains how the system is structured and how a trade moves through it. It does not contain operational configuration, exact trading parameters, credentials, or deployment details.

## Documents

| Document | What it covers |
|---|---|
| [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) | Purpose, operating modes, and the main building blocks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Subsystems, responsibilities, data stores, and external integrations |
| [WORKFLOW.md](WORKFLOW.md) | The scan cycle and the full trade lifecycle from signal to learning |
| [TRADING_PIPELINE.md](TRADING_PIPELINE.md) | Stage-by-stage pipeline, including rejections and failure branches |
| [RISK_AND_EXECUTION.md](RISK_AND_EXECUTION.md) | Risk validation, the ARM execution gate, order handling, and position protection |
| [COMPONENT_INTERACTION.md](COMPONENT_INTERACTION.md) | How components communicate: calls, persistence, streams, and REST |

## Diagrams

Each diagram file contains Mermaid sources with a written explanation.

- [system-overview.md](diagrams/system-overview.md)
- [trading-pipeline.md](diagrams/trading-pipeline.md)
- [decision-flow.md](diagrams/decision-flow.md)
- [order-lifecycle.md](diagrams/order-lifecycle.md)
- [component-interaction.md](diagrams/component-interaction.md)

## Verification status

Statements were checked against the source tree on this branch. Behaviors that were not fully traced are listed under "Undocumented or partially verified" in ARCHITECTURE.md.
