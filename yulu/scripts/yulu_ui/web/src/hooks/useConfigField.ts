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

/** Return a shallow-cloned config snapshot with a dotted path patched. */
function setValueAt<T>(cfg: T, key: string, value: unknown): T {
  if (cfg == null || typeof cfg !== "object") return cfg;
  const parts = key.split(".");
  const root = Array.isArray(cfg) ? [...cfg] : { ...(cfg as Record<string, unknown>) };
  let out: Record<string, unknown> = root as Record<string, unknown>;
  let src: unknown = cfg;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const srcChild = src != null && typeof src === "object"
      ? (src as Record<string, unknown>)[part]
      : undefined;
    const next = srcChild != null && typeof srcChild === "object"
      ? (Array.isArray(srcChild) ? [...srcChild] : { ...(srcChild as Record<string, unknown>) })
      : {};
    out[part] = next;
    out = next as Record<string, unknown>;
    src = srcChild;
  }
  out[parts[parts.length - 1]!] = value;
  return root as T;
}

export interface CommitOptions {
  /**
   * Suppress recording this key's restart requirement in the tracker (so the
   * RestartBanner does NOT trip for this commit). Used for whole-array edits
   * whose *content* doesn't actually need a daemon restart — e.g. appending a
   * DISABLED calendar provider, or removing/editing a disabled entry (P4a-4).
   * Enabling an entry uses the normal (un-suppressed) path so it still trips
   * the banner. The server-side write/validation is identical either way; this
   * only affects the client-side restart hint.
   */
  suppressRestart?: boolean;
}

export interface ConfigFieldApi {
  /**
   * Section-facing commit, same shape sections already used
   * (`commit(key)(value)`), but now routed through the shared guard + undo:
   *  - blocked restart-class edits while recording are dropped (the row is also
   *    `disabled`, so this is defense-in-depth);
   *  - successful saves record the restart need in the tracker and pop an undo
   *    toast that re-commits the previous value.
   * An optional `opts.suppressRestart` skips the restart-tracking for content
   * edits that don't truly need a restart (see CommitOptions).
   */
  commit: (key: string, opts?: CommitOptions) => (value: unknown) => Promise<unknown> | undefined;
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
  const utils = trpc.useUtils();

  // Restart-tracking happens in doCommit (so it can be suppressed per-commit),
  // not in a fixed onSuccess — otherwise every calendars array edit would trip
  // the banner regardless of content (P4a-4).
  const updateMut = trpc.config.update.useMutation();

  const isBlocked = useCallback((key: string): boolean => {
    if (!isRecording) return false;
    return defFor(schema, key)?.reload.kind === "restart";
  }, [isRecording, schema]);

  // The actual persist + undo-toast, shared by the plain and danger-confirmed
  // paths. Returns the mutation promise so callers can await it. Records the
  // restart need on success unless `suppressRestart` is set.
  const doCommit = useCallback((key: string, value: unknown, def: SettingMeta | undefined, suppressRestart: boolean) => {
    const prev = valueAt(cfg, key);
    const p = updateMut.mutateAsync({ key, value });
    p.then((res: { daemonsNeedingRestart: string[] }) => {
      utils.config.get.setData(undefined, (old) => setValueAt(old, key, value));
      void utils.config.get.invalidate();
      if (!suppressRestart) tracker.record(key, res.daemonsNeedingRestart);
      showUndo({
        label: def?.label ?? key,
        // The undo re-commit mirrors this commit's suppression so undoing an
        // add/remove doesn't surprise the user with a restart banner.
        onUndo: () => {
          const up = updateMut.mutateAsync({ key, value: prev });
          up.then((r: { daemonsNeedingRestart: string[] }) => {
            utils.config.get.setData(undefined, (old) => setValueAt(old, key, prev));
            void utils.config.get.invalidate();
            if (!suppressRestart) tracker.record(key, r.daemonsNeedingRestart);
          }).catch(() => {});
        },
      });
    }).catch(() => { /* surfaced elsewhere; no toast on failure */ });
    return p;
  }, [cfg, updateMut, showUndo, tracker, utils]);

  const commit = useCallback((key: string, opts?: CommitOptions) => (value: unknown) => {
    if (isBlocked(key)) return undefined;            // guard: drop the edit
    const def = defFor(schema, key);
    const suppressRestart = opts?.suppressRestart ?? false;
    // Danger-flagged fields (e.g. audio.output_dir, audio.backend,
    // transcription.local_model_path / .mlx) ask for an explicit confirm before
    // persisting — the same honest opt-in as the cloud-folder warning, but
    // generic. A decline drops the edit silently (no commit, no toast). NON-danger
    // fields keep the original synchronous path untouched (no regression).
    if (def?.danger) {
      return confirm(def.label ?? key).then((ok) => {
        if (!ok) return undefined;
        return doCommit(key, value, def, suppressRestart);
      });
    }
    return doCommit(key, value, def, suppressRestart);
  }, [isBlocked, schema, confirm, doCommit]);

  return { commit, isBlocked, isRecording };
}
