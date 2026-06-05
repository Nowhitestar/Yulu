import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecordingStatusBadge } from "../../web/src/components/RecordingStatusBadge.js";

describe("RecordingStatusBadge", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<RecordingStatusBadge state="idle" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an unknown state", () => {
    const { container } = render(<RecordingStatusBadge state="done" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a Transcribing label while transcribing", () => {
    render(<RecordingStatusBadge state="transcribing" />);
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.getByTestId("recording-status")).toHaveAttribute("data-state", "transcribing");
  });

  it("shows a Summarizing label while summarizing", () => {
    render(<RecordingStatusBadge state="summarizing" />);
    expect(screen.getByText("Summarizing")).toBeInTheDocument();
  });

  it("shows Failed with the error in a tooltip", () => {
    render(<RecordingStatusBadge state="failed" error="it broke" />);
    const badge = screen.getByTestId("recording-status");
    expect(badge).toHaveTextContent("Failed");
    expect(badge).toHaveAttribute("title", "it broke");
  });

  it("compact mode hides the text label but keeps the badge", () => {
    render(<RecordingStatusBadge state="transcribing" compact />);
    expect(screen.queryByText("Transcribing")).toBeNull();
    expect(screen.getByTestId("recording-status")).toBeInTheDocument();
  });
});
