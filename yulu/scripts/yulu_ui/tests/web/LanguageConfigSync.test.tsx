import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { updateSpy, invalidateSpy, state } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  invalidateSpy: vi.fn(),
  state: { outcome: "apply-error" as "apply-error" | "save-error" },
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { ui: { language: "zh" } } }) },
      update: {
        useMutation: () => ({
          mutate: (vars: { key: string; value: unknown }, opts: {
            onSuccess?: (result: { applyErrors?: string[] }) => void;
            onError?: (error: unknown) => void;
            onSettled?: () => void;
          }) => {
            updateSpy(vars);
            if (state.outcome === "apply-error") opts.onSuccess?.({ applyErrors: ["statusagent: service unavailable"] });
            else opts.onError?.(new Error("config changed externally"));
            opts.onSettled?.();
          },
        }),
      },
    },
    useUtils: () => ({ config: { get: { invalidate: invalidateSpy } } }),
  },
}));

import { LanguageConfigSync, LanguageProvider, useLang } from "../../web/src/i18n/LanguageProvider.js";
import { UndoToastProvider, useUndoToast } from "../../web/src/components/UndoToast.js";

function SyncWithToast() {
  const { showError } = useUndoToast();
  return <LanguageConfigSync onError={showError} />;
}

function SwitchLanguage() {
  const { setLang } = useLang();
  return <button type="button" onClick={() => setLang("en")}>English</button>;
}

function mount() {
  return render(
    <LanguageProvider>
      <UndoToastProvider>
        <SyncWithToast />
        <SwitchLanguage />
      </UndoToastProvider>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  updateSpy.mockClear();
  invalidateSpy.mockClear();
  state.outcome = "apply-error";
});

describe("LanguageConfigSync", () => {
  it("shows when the language preference saved but StatusAgent did not apply it", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("service unavailable"));
    expect(updateSpy).toHaveBeenCalledWith({ key: "ui.language", value: "en" });
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("shows language preference persistence failures", async () => {
    state.outcome = "save-error";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("config changed externally"));
  });
});
