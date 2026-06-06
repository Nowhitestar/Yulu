// web/src/hooks/useConfigField.ts
import { useCallback } from "react";
import { trpc } from "../trpc.js";
import { useUndoToast } from "../components/UndoToast.js";
import { useDangerConfirm } from "../components/DangerConfirm.js";
import { useIsRecording } from "./useIsRecording.js";
import { useSettingsSchema, type SettingMeta } from "./useSettingsSchema.js";
import type { SettingsRestartTracker } from "./useSettingsRestartTracker.js";

/**
 * Prefix match a config key against the registry, longest-prefix wins — mirrors
 * the server's `defFor` so a sub-field key like `transcription.mlx.model`
 * resolves to its parent `transcription.mlx` definition (and its reload class).
 */
function defFor(schema: SettingMeta[] | undefined, key: string): SettingMeta | undefined {
  if (!schema) return undefined;
  let best: SettingMeta | undefined;
  for (const d of schema) {
    if (key === d.path || key.startsWith(d.path + ".")) {
      if (!best || d.path.length > best.path.length) best = d;
    }
  }
  return best;
}

/** Read a dotted path out of the live config snapshot (for undo's previous value). */
function valueAt(cfg: unknown, key: string): unknown {
  let cur: unknown = cfg;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface ConfigFieldApi {
  /**
   * Section-facing commit, same shape sections already used
   * (`commit(key)(value)`), but now routed through the shared guard + undo:
   *  - blocked restart-class edits while recording are dropped (the row is also
   *    `disabled`, so this is defense-in-depth);
   *  - successful saves record the restart need in the tracker and pop an undo
   *    toast that re-commits the previous value.
   */
  commit: (key: string) => (value: unknown) => Promise<unknown> | undefined;
  /** True when this key must not be edited right now (restart-class + recording). */
  isBlocked: (key: string) => boolean;
  /** True while a recording/processing is in flight. */
  isRecording: boolean;
}

/**
 * The single commit path for settings fields. Sections call
 * `useConfigField(tracker)` and route every `config.update` through `commit`, so
 * the recording-guard (restart-class fields can't be changed mid-recording) and
 * the undo toast apply uniformly across all categories.
 */
export function useConfigField(tracker: SettingsRestartTracker): ConfigFieldApi {
  const { data: schema } = useSettingsSchema();
  const { data: cfg } = trpc.config.get.useQuery();
  const isRecording = useIsRecording();
  const { showUndo } = useUndoToast();
  const { confirm } = useDangerConfirm();

  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });

  const isBlocked = useCallback((key: string): boolean => {
    if (!isRecording) return false;
    return defFor(schema, key)?.reload.kind === "restart";
  }, [isRecording, schema]);

  // The actual persist + undo-toast, shared by the plain and danger-confirmed
  // paths. Returns the mutation promise so callers can await it.
  const doCommit = useCallback((key: string, value: unknown, def: SettingMeta | undefined) => {
    const prev = valueAt(cfg, key);
    const p = updateMut.mutateAsync({ key, value });
    p.then(() => {
      showUndo({
        label: def?.label ?? key,
        onUndo: () => { updateMut.mutateAsync({ key, value: prev }); },
      });
    }).catch(() => { /* surfaced elsewhere; no toast on failure */ });
    return p;
  }, [cfg, updateMut, showUndo]);

  const commit = useCallback((key: string) => (value: unknown) => {
    if (isBlocked(key)) return undefined;            // guard: drop the edit
    const def = defFor(schema, key);
    // Danger-flagged fields (e.g. audio.output_dir, audio.backend,
    // transcription.local_model_path / .mlx) ask for an explicit confirm before
    // persisting — the same honest opt-in as the cloud-folder warning, but
    // generic. A decline drops the edit silently (no commit, no toast). NON-danger
    // fields keep the original synchronous path untouched (no regression).
    if (def?.danger) {
      return confirm(def.label ?? key).then((ok) => {
        if (!ok) return undefined;
        return doCommit(key, value, def);
      });
    }
    return doCommit(key, value, def);
  }, [isBlocked, schema, confirm, doCommit]);

  return { commit, isBlocked, isRecording };
}
