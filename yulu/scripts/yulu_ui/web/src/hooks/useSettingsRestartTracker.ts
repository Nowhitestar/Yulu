import { useReducer, useMemo } from "react";

type DaemonsByKey = Map<string, Set<string>>;

export type RowStatus = "saved" | "restart" | "typing" | null;

interface State { daemons: DaemonsByKey; }

type Action =
  | { type: "record"; key: string; daemons: string[] }
  | { type: "clearDaemon"; name: string }
  | { type: "clearKey"; key: string }
  | { type: "clearAll" };

function reducer(state: State, action: Action): State {
  const next = new Map(Array.from(state.daemons, ([k, v]) => [k, new Set(v)] as const));
  switch (action.type) {
    case "record": {
      if (action.daemons.length === 0) return state;
      for (const d of action.daemons) {
        const set = next.get(d) ?? new Set();
        set.add(action.key);
        next.set(d, set);
      }
      return { daemons: next };
    }
    case "clearDaemon": {
      next.delete(action.name);
      return { daemons: next };
    }
    case "clearKey": {
      for (const [d, set] of next) {
        if (set.delete(action.key) && set.size === 0) next.delete(d);
      }
      return { daemons: next };
    }
    case "clearAll":
      return { daemons: new Map() };
  }
}

export interface SettingsRestartTracker {
  daemons: DaemonsByKey;
  record: (key: string, daemonsNeedingRestart: string[]) => void;
  statusFor: (key: string) => RowStatus;
  clearDaemon: (name: string) => void;
  clearKey: (key: string) => void;
  clearAll: () => void;
}

export function useSettingsRestartTracker(): SettingsRestartTracker {
  const [state, dispatch] = useReducer(reducer, { daemons: new Map() });

  return useMemo<SettingsRestartTracker>(() => ({
    daemons: state.daemons,
    record: (key, daemons) => dispatch({ type: "record", key, daemons }),
    statusFor: (key) => {
      for (const set of state.daemons.values()) if (set.has(key)) return "restart";
      return null;
    },
    clearDaemon: (name) => dispatch({ type: "clearDaemon", name }),
    clearKey: (key) => dispatch({ type: "clearKey", key }),
    clearAll: () => dispatch({ type: "clearAll" }),
  }), [state.daemons]);
}
