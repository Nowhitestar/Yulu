import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurrentMeetingAction } from "../../../web/src/components/CurrentMeetingAction.js";

const currentMock = vi.fn();
const saveMutate = vi.fn();
const startMutate = vi.fn();
let isRecording = false;

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    scheduler: {
      current: { useQuery: () => currentMock() },
      setPrimaryAction: { useMutation: () => ({ mutate: saveMutate }) },
      startMeeting: { useMutation: () => ({ mutate: startMutate, isPending: false }) },
    },
  },
}));

vi.mock("../../../web/src/hooks/useIsRecording.js", () => ({
  useIsRecording: () => isRecording,
}));

beforeEach(() => {
  isRecording = false;
  currentMock.mockReturnValue({
    data: {
      primaryAction: "record_join",
      meeting: {
        id: "m-current",
        title: "Ops Weekly",
        link: "https://meet.example/current",
      },
    },
  });
  saveMutate.mockReset();
  startMutate.mockReset();
});

describe("CurrentMeetingAction", () => {
  it("renders one visible current action instead of duplicating it in a select", async () => {
    render(<CurrentMeetingAction />);

    await screen.findByText("录制并加入");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByText("录制并加入")).toHaveLength(1);
  });

  it("shows only the alternate action in the menu and persists it", async () => {
    const user = userEvent.setup();
    render(<CurrentMeetingAction />);

    await user.click(screen.getByRole("button", { name: "当前会议录制动作" }));

    expect(screen.getByRole("menuitem", { name: "录制" })).toBeInTheDocument();
    expect(screen.getAllByText("录制并加入")).toHaveLength(1);

    await user.click(screen.getByRole("menuitem", { name: "录制" }));
    expect(saveMutate).toHaveBeenCalledWith({ action: "record" });
  });

  it("starts with the saved primary action", async () => {
    const user = userEvent.setup();
    render(<CurrentMeetingAction />);

    await user.click(screen.getByRole("button", { name: /录制当前会议/ }));

    expect(startMutate).toHaveBeenCalledWith({
      meetingId: "m-current",
      action: "record_join",
    });
  });

  it("hides the current-meeting action while recording is already active", () => {
    isRecording = true;

    render(<CurrentMeetingAction fallback={<button type="button">录制</button>} />);

    expect(screen.queryByText("录制并加入")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "录制" })).toBeInTheDocument();
  });

  it("falls back to the normal record control without a current calendar meeting", () => {
    currentMock.mockReturnValue({ data: { primaryAction: "record_join", meeting: null } });

    render(<CurrentMeetingAction fallback={<button type="button">录制</button>} />);

    expect(screen.queryByText("录制并加入")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "录制" })).toBeInTheDocument();
  });

  it("shows record only when the current calendar meeting has no join link", async () => {
    const user = userEvent.setup();
    currentMock.mockReturnValue({
      data: {
        primaryAction: "record_join",
        meeting: {
          id: "m-current",
          title: "Ops Weekly",
          link: "",
        },
      },
    });

    render(<CurrentMeetingAction fallback={<button type="button">录制 fallback</button>} />);

    expect(screen.queryByText("录制并加入")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "当前会议录制动作" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /录制当前会议/ }));
    expect(startMutate).toHaveBeenCalledWith({
      meetingId: "m-current",
      action: "record",
    });
  });
});
