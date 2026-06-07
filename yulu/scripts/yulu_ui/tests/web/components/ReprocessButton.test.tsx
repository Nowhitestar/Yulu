import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { ReprocessButton } from "../../../web/src/components/ReprocessButton";

describe("ReprocessButton", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders the label in idle state", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span data-testid="i" />} state="idle" onClick={() => {}} />);
    expect(screen.getByText("Re-transcribe")).toBeInTheDocument();
  });

  it("calls onClick when clicked in idle state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows 'Running…' text and is disabled in running state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="running" onClick={onClick} />);
    expect(screen.getByText("运行中…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows Done text in done state and auto-transitions back after 2s", () => {
    const { rerender } = render(<ReprocessButton label="Re-transcribe" icon={<span />} state="running" onClick={() => {}} />);
    rerender(<ReprocessButton label="Re-transcribe" icon={<span />} state="done" onClick={() => {}} />);
    expect(screen.getByText("完成")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText("完成")).toBeNull();
  });

  it("renders error tooltip in failed state", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="failed" error="ffmpeg crash" onClick={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title") ?? btn.getAttribute("aria-label")).toContain("ffmpeg crash");
  });

  it("calls onClick from failed state (retry)", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="failed" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });

  it("respects disabled prop in idle state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={onClick} disabled disabledReason="WAV missing" />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows disabledReason via title when disabled", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={() => {}} disabled disabledReason="WAV missing" />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toContain("WAV missing");
  });
});
