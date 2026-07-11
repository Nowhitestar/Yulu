// tests/web/useConfigField.danger.test.tsx
// P3-3: the danger-confirm gate in the shared commit path. A danger-flagged
// field must NOT persist until the user accepts the confirm; a decline drops the
// edit (no config.update, no toast). A non-danger field commits with no confirm.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
const showUndo = vi.fn();
const configSetData = vi.fn();
const configInvalidate = vi.fn();

// audio.output_dir is danger + restart-class; product language and llm.enabled
// apply without daemon reload. useConfigField looks all of these up.
const SCHEMA = [
  { path: "audio.output_dir",          category: "audio",         label: "Recording output dir", type: "path",   danger: true, reload: { kind: "restart", daemons: ["audiodaemon"] } },
  { path: "transcription.language",    category: "transcription", label: "Language",             type: "text",                 reload: { kind: "none" } },
  { path: "llm.enabled",               category: "llm",           label: "Enabled",              type: "toggle",               reload: { kind: "none" } },
];

let recordingState = "idle";

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

vi.mock("../../web/src/components/UndoToast.js", () => ({
  useUndoToast: () => ({ showUndo }),
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: { output_dir: "/old" }, transcription: { language: "auto" }, llm: { enabled: false } }, isPending: false }) },
      schema: { useQuery: () => ({ data: SCHEMA, isPending: false }) },
      update: { useMutation: (opts?: { onSuccess?: (r: unknown, v: unknown) => void }) => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => {
          const res = await updateMutate(vars);
          opts?.onSuccess?.(res, vars);
          return res;
        },
      }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    useUtils: () => ({
      config: { get: { setData: configSetData, invalidate: configInvalidate } },
    }),
  },
}));

import { DangerConfirmProvider } from "../../web/src/components/DangerConfirm.js";
import { useConfigField } from "../../web/src/hooks/useConfigField.js";

const tracker = { record: vi.fn(), statusFor: () => null, clearDaemon: vi.fn(), daemons: new Map() } as never;

// A tiny harness exposing buttons that call commit(key)(value) for each field.
function Harness() {
  const { commit } = useConfigField(tracker);
  return (
    <>
      <button type="button" onClick={() => commit("audio.output_dir")("/new")}>danger</button>
      <button type="button" onClick={() => commit("llm.enabled")(true)}>plain</button>
    </>
  );
}

function mount() {
  return render(
    <DangerConfirmProvider>
      <Harness />
    </DangerConfirmProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
  showUndo.mockClear();
  configSetData.mockClear();
  configInvalidate.mockClear();
  recordingState = "idle";
});

describe("useConfigField — danger-confirm gate (P3-3)", () => {
  it("a danger field opens a confirm and does NOT commit until accepted", async () => {
    mount();
    fireEvent.click(screen.getByText("danger"));
    // Confirm dialog appears; nothing persisted yet.
    await waitFor(() => screen.getByRole("alertdialog"));
    expect(updateMutate).not.toHaveBeenCalled();
    // Accept → the edit persists with the new value.
    fireEvent.click(screen.getByRole("button", { name: /应用/i }));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ key: "audio.output_dir", value: "/new" }));
    expect(showUndo).toHaveBeenCalled();
  });

  it("declining the confirm drops the edit — no commit, no undo toast", async () => {
    mount();
    fireEvent.click(screen.getByText("danger"));
    await waitFor(() => screen.getByRole("alertdialog"));
    fireEvent.click(screen.getByRole("button", { name: /取消/i }));
    // Give any (incorrect) async commit a chance to fire, then assert it didn't.
    await act(async () => { await Promise.resolve(); });
    expect(updateMutate).not.toHaveBeenCalled();
    expect(showUndo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a non-danger field commits immediately with no confirm dialog", async () => {
    mount();
    fireEvent.click(screen.getByText("plain"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ key: "llm.enabled", value: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(showUndo).toHaveBeenCalled();
  });

  it("patches the config.get cache after a successful commit", async () => {
    mount();
    fireEvent.click(screen.getByText("plain"));
    await waitFor(() => expect(configSetData).toHaveBeenCalled());
    const updater = configSetData.mock.calls[0]![1] as (old: unknown) => unknown;
    expect(updater({ llm: { enabled: false }, output: { channel: "file" } })).toEqual({
      llm: { enabled: true },
      output: { channel: "file" },
    });
    expect(configInvalidate).toHaveBeenCalled();
  });
});
