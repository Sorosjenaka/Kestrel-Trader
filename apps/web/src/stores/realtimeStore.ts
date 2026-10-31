import { create } from "zustand";

/**
 * Store realtime dasar (Tahap 1 redesign Tema B).
 * Nanti diisi: ticker/mark price dari binanceWs, header status
 * (ganti headerSubs manual di App.tsx), state Control Room.
 */

export type HeaderStatus = { armed: boolean | null; executionMode: string };

export type ControlRoomView = "network" | "lacak" | "grid";

type ControlRoomState = {
  view: ControlRoomView;
  selectedNodeId: string | null;
  traceId: string | null;
  paused: boolean;
  feedFilter: string;
};

type RealtimeStore = {
  headerStatus: HeaderStatus;
  setHeaderStatus: (s: HeaderStatus) => void;
  controlRoom: ControlRoomState;
  setControlRoom: (partial: Partial<ControlRoomState>) => void;
};

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  headerStatus: { armed: null, executionMode: "" },
  setHeaderStatus: (s) => set({ headerStatus: s }),
  controlRoom: {
    view: "network",
    selectedNodeId: null,
    traceId: null,
    paused: false,
    feedFilter: "SEMUA",
  },
  setControlRoom: (partial) =>
    set((state) => ({ controlRoom: { ...state.controlRoom, ...partial } })),
}));