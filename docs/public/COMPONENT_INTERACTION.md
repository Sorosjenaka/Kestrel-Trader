# Component Interaction

This document describes how components communicate and the mechanism of each link. Diagrams are in [diagrams/component-interaction.md](diagrams/component-interaction.md).

## Communication mechanisms

| Mechanism | Used between | Notes |
|---|---|---|
| Direct function calls | Scanner, engines, risk, executor, supervisor inside the server | Same process, synchronous or awaited |
| REST (outbound) | Server to Binance USD-M and LLM provider | Host rotation and retry in the REST pool |
| WebSocket (inbound) | Binance streams to market data managers | Reconnect and staleness checks |
| Persistence | Server to SQLite via Prisma | Decisions, orders, positions, events |
| Server-sent events | Server to dashboard for live panels | One-way, from server to browser |
| REST (inbound) | Dashboard to server | Queries and operator actions |
| Shared database reads | Watchdog to position state | Read access to open-position state; exits are sent to the exchange, not to the server |
| Exchange as shared state | Server and watchdog to exchange | Protective orders are placed on the exchange so they survive a server outage |

## Interaction summary

- The **market data managers** write normalized prices and candles into in-memory caches read by the scanner.
- The **scanner** publishes completed scan views. The **entry funnel** reads them.
- The **decision layer** calls LLM providers over REST. Its outputs are recorded in the decision log.
- The **risk engine** is called by the entry funnel and returns a plan or rejection. It does not send orders.
- The **executor** is the only component that sends entry orders to the exchange.
- The **supervisor** reads open positions and writes exits through the executor's exit path.
- The **watchdog** reads open-position levels and sends reduce-only closes independently of the server.
- The **reconciler** compares database state with an exchange snapshot at startup.
- The **learning loop** reads closed trades and writes statistics and proposed parameter versions.
- The **dashboard** reads state through REST and receives live updates through server-sent events.

## Failure isolation

- A failed market data stream affects only the symbols it covers.
- A failed LLM call affects only the stage that depends on it.
- A server outage leaves protective orders on the exchange and the watchdog running.
- A failed dashboard connection does not affect trading.
