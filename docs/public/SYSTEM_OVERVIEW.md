# System Overview

Kestrel-Trader is an automated trading system for crypto perpetual futures on Binance USD-M. It scans a filtered universe of contracts, scores trade setups, asks several analysis roles to review the best ones, applies deterministic risk rules, and then either records a planned order or sends it, depending on its execution mode. Once a position is open, the system manages stop-loss and take-profit levels and records the outcome for later review.

## Design principles

- **Deterministic gates first.** Market data, technical engines, and risk rules decide whether a candidate may proceed. AI-assisted review only adds a further filter; it cannot create an entry on its own.
- **Fail closed at execution boundaries.** Missing approvals, stale data, or unavailable services prevent an order rather than allow one.
- **Execution is gated by an explicit arming switch.** Orders that reach the exchange require the ARM state. Reduce-only exits are exempt so open positions can still be closed.
- **Independent protection.** Stop-loss and take-profit logic exists in the main server and also in a separate watchdog process.
- **Every decision is logged.** Decisions, rejections, and exits are written to the database for audit and for the learning loop.

## Operating modes

| Mode | Behavior |
|---|---|
| PAPER | Orders are simulated against market data. No orders reach the exchange. |
| LIVE | Orders may be sent to the exchange, but only while the ARM state is on. |

The default state is not armed. Turning ARM on is a deliberate operator action and is never part of normal startup.

## Main building blocks

| Block | Role |
|---|---|
| Universe manager | Maintains the list of tradeable USDT-margined perpetual contracts |
| Market data layer | Connects to exchange REST endpoints and WebSocket streams |
| Scanner | Evaluates many symbols in parallel on fixed intervals |
| Signal engines | Compute regime, structure, trigger, and trend information |
| Decision layer | AI-assisted setup judge and risk officer, plus a pre-entry review council |
| Risk engine | Sizes positions, enforces margin and leverage limits, and blocks unsafe entries |
| Executor | Places orders idempotently and verifies fills |
| Position supervisor | Monitors open positions and applies stop-loss, take-profit, and timeout exits |
| Watchdog | Independent process that enforces stop-loss and take-profit from the last traded price |
| Reconciler | Compares stored positions with exchange state at startup |
| Learning loop | Post-mortem analysis of closed trades and proposed parameter changes |
| Dashboard | Web interface for monitoring state, positions, and events |

Each block is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Technology stack

Verified from the package manifests and source:

- **Server:** TypeScript on Node.js, Express 5, `ws` for WebSocket clients, Zod for input validation, Pino for logging.
- **Database:** Prisma 6 with a SQLite datasource.
- **Dashboard:** React 19, Vite 8, Zustand, TanStack React Query.
- **Watchdog:** Python 3.
- **Tests:** Vitest for the server; Python test files for the watchdog.

## Scope limits

- The system is not a finished product. Some modes and subsystems are experimental, and live operation depends on the operator's own exchange account and risk configuration.
- Nothing in this documentation is financial advice.
