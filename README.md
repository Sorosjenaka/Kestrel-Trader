# Kestrel Trader

Trading system for Binance USDT-M futures. Default mode is PAPER (simulated) and ARM is OFF, so no real orders are sent.

- Pipeline (EN): docs/diagrams/kestrel-pipeline-en.png
- Workflow (EN): docs/diagrams/kestrel-workflow-en.png
- Pipeline (ID): docs/diagrams/kestrel-pipeline-id.png
- Workflow (ID): docs/diagrams/kestrel-workflow-id.png

## Setup

1. Copy `.env.example` to `apps/server/.env` and fill in your own keys.
2. Keep `BINANCE_EXECUTION_MODE=PAPER` and `ARM_DEFAULT=false` until you have tested thoroughly.
3. Install and run with Node and npm.

Trading is risky. This software is provided as-is under the MIT license.
