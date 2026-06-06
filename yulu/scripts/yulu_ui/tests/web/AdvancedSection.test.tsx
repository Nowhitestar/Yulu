// tests/web/AdvancedSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => configReturn },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
    },
  },
}));

import { AdvancedSection } from "../../web/src/components/settings/AdvancedSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

beforeEach(() => {
  updateMutate.mockClear();
  configReturn = { data: { transcription: { cloud_command: [] } }, isPending: false };
});

function mount() {
  return render(
    <MemoryRouter>
      <AdvancedSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("AdvancedSection — cloud transcription command (TRANS-02, re-homed)", () => {
  it("renders the cloud transcription command as a CommandEditor (array, not a key)", () => {
    mount();
    // Exact match for the label (the help text also contains the phrase).
    expect(screen.getByText("Cloud transcription command")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /\+ add arg/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("editing the command persists transcription.cloud_command", async () => {
    mount();
    const addArg = screen.getAllByRole("button", { name: /\+ add arg/i });
    const user = userEvent.setup();
    await user.click(addArg[addArg.length - 1]!);
    await vi.waitFor(() =>
      expect(updateMutate.mock.calls.some((c) => c[0]?.key === "transcription.cloud_command")).toBe(true),
    );
  });

  it("exposes no api key / token / secret / password field (T-04-KEY)", () => {
    const { container } = mount();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const offenders = Array.from(container.querySelectorAll("*")).filter((el) => {
      const ph = el.getAttribute("placeholder") ?? "";
      const aria = el.getAttribute("aria-label") ?? "";
      return /api[\s_-]?key|token|secret|password/i.test(`${ph} ${aria}`);
    });
    expect(offenders).toEqual([]);
  });
});
