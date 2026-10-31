// apps/server/src/exec/orderStateMachine.ts — T-14 / CP-4 (19 Okt 2026).
// State machine formal untuk OrderExec. Murni + deterministik; dipakai repo
// updateStatus untuk mendeteksi transisi ilegal (log warning, bukan throw —
// histori DB lama tidak boleh membuat service gagal).
//
//   NEW ──> PARTIAL ──> FILLED
//    │        │
//    ├──> FILLED
//    ├──> CANCELED / REJECTED / EXPIRED
//    └──> (PARTIAL juga bisa CANCELED / EXPIRED)
//
// State terminal tidak pernah keluar. Transisi ke state yang sama = idempotent
// (poll exchange boleh mengulang status yang sama).

export type OrderState = "NEW" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export type OrderEvent = "PARTIAL_FILL" | "FILL" | "CANCEL" | "REJECT" | "EXPIRE";

const TERMINAL: ReadonlySet<OrderState> = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

const TRANSITIONS: Record<OrderState, ReadonlySet<OrderState>> = {
  NEW: new Set(["NEW", "PARTIAL", "FILLED", "CANCELED", "REJECTED", "EXPIRED"]),
  PARTIAL: new Set(["PARTIAL", "FILLED", "CANCELED", "EXPIRED"]),
  FILLED: new Set(["FILLED"]),
  CANCELED: new Set(["CANCELED"]),
  REJECTED: new Set(["REJECTED"]),
  EXPIRED: new Set(["EXPIRED"]),
};

const EVENT_TARGET: Record<OrderEvent, OrderState> = {
  PARTIAL_FILL: "PARTIAL",
  FILL: "FILLED",
  CANCEL: "CANCELED",
  REJECT: "REJECTED",
  EXPIRE: "EXPIRED",
};

export function isOrderState(value: string): value is OrderState {
  return value === "NEW" || value === "PARTIAL" || value === "FILLED"
    || value === "CANCELED" || value === "REJECTED" || value === "EXPIRED";
}

export function isTerminalState(state: OrderState): boolean {
  return TERMINAL.has(state);
}

/** Transisi legal? State sama selalu boleh (idempotent). Unknown state = false. */
export function canTransition(from: string, to: string): boolean {
  if (!isOrderState(from) || !isOrderState(to)) return false;
  return TRANSITIONS[from].has(to);
}

/** Lempar error untuk transisi ilegal — dipakai di test/flow yang butuh keras. */
export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) throw new Error(`ORDER_STATE_ILLEGAL:${from}->${to}`);
}

/** State berikutnya dari event exchange; null bila event tidak valid untuk state. */
export function nextState(from: string, event: OrderEvent): OrderState | null {
  if (!isOrderState(from)) return null;
  const to = EVENT_TARGET[event];
  return TRANSITIONS[from].has(to) ? to : null;
}
