# Kestrel Trader

Trading system for Binance USDT-M futures. Default mode is PAPER (simulated) and ARM is OFF, so no real orders are sent.

**Panduan Bahasa Indonesia (lengkap): [docs/id/](docs/id/README.md)** — ikhtisar & fitur, alur kerja + diagram, tutorial pemasangan.

- Pipeline (EN): docs/diagrams/kestrel-pipeline-en.png
- Workflow (EN): docs/diagrams/kestrel-workflow-en.png
- Pipeline (ID): docs/diagrams/kestrel-pipeline-id.png
- Workflow (ID): docs/diagrams/kestrel-workflow-id.png
- Arsitektur & workflow (EN, detail): [docs/public/](docs/public/README.md)

## Features

- Realtime market scanner (REST + WebSocket) over liquid futures pairs
- Multi-timeframe signal engine with validated entry, invalidation, and exit plans
- Layered AI review (setup judge, risk officer, pre-entry review panel) — all fail-closed
- Deterministic risk gates: position sizing, liquidation protection, daily limits, volatility shield
- Automatic position management (staged take-profit, break-even stop, supervisor + watchdog)
- Paper simulation mode by default; separate explicit execution switch (ARM) for live orders
- Realtime web dashboard: KPIs, equity/position charts, decision logs, live PnL
- Continuous learning loop: evaluation, backtesting, strategy research catalog

## Setup

1. Copy `.env.example` to `apps/server/.env` and fill in your own keys.
2. Keep `BINANCE_EXECUTION_MODE=PAPER` and `ARM_DEFAULT=false` until you have tested thoroughly.
3. Install and run with Node and npm.

Step-by-step guide (Indonesian): [docs/id/03-tutorial-pasang.md](docs/id/03-tutorial-pasang.md)

Trading is risky. This software is provided as-is under the MIT license.
