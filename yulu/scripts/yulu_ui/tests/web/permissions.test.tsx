import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const mock = vi.hoisted(() => ({
  data: { macosMajor: 27 as number | null, voiceInputEnabled: true, microphone: "ready", systemAudio: "ready", systemAudioCapturing: false as boolean | null, input: "needs_attention", notifications: "not_determined" },
  isError: false, refetch: vi.fn(async () => ({})), open: vi.fn(async () => ({})),
}));
vi.mock("../../web/src/trpc.js", () => ({ trpc: { permissions: {
  status: { useQuery: () => ({ data: mock.data, isError: mock.isError, isFetching: false, refetch: mock.refetch }) },
  openSettings: { useMutation: () => ({ mutateAsync: mock.open, isPending: false }) },
} } }));
import { PermissionsPanel, PermissionReminder } from "../../web/src/components/PermissionsPanel.js";

function wrap(element = <PermissionsPanel />) {
  localStorage.setItem("yulu_ui.lang", "zh");
  return render(<MemoryRouter><LanguageProvider>{element}</LanguageProvider></MemoryRouter>);
}
afterEach(() => {
  mock.data = { macosMajor: 27, voiceInputEnabled: true, microphone: "ready", systemAudio: "ready", systemAudioCapturing: false, input: "needs_attention", notifications: "not_determined" };
  mock.isError = false; mock.open.mockClear(); mock.refetch.mockClear(); localStorage.clear();
});

describe("permission guidance", () => {
  it.each([[27, "设备控制和数据访问"], [26, "辅助功能"]])("uses the system label on macOS %s", (version, label) => {
    mock.data.macosMajor = version as number;
    wrap();
    expect(screen.getByText(`隐私与安全性 → ${label} → Yulu`)).toBeInTheDocument();
    expect(screen.getByText("可选")).toBeInTheDocument();
    expect(mock.open).not.toHaveBeenCalled();
  });
  it("opens only the chosen permission and never treats navigation as authorization", async () => {
    const user = userEvent.setup();
    const { container } = wrap();
    const input = within(container.querySelector('[data-permission="input"]')! as HTMLElement);
    await user.click(input.getByRole("button", { name: "前往设置" }));
    expect(mock.open).toHaveBeenCalledWith({ permission: "input" });
    expect(input.getByText("待开启或检查")).toBeInTheDocument();
    mock.refetch.mockClear();
    fireEvent.focus(window);
    expect(mock.refetch).toHaveBeenCalledOnce();
  });
  it("does not keep stale green states after a failed refresh", () => {
    mock.data.input = "ready"; mock.isError = true;
    wrap();
    expect(screen.queryByText("已就绪")).toBeNull();
    expect(screen.getAllByText("检测失败")).toHaveLength(4);
    expect(screen.queryByText("已授权 · 未采集")).toBeNull();
  });
  it("shows access while idle or dictating without a missing-audio reminder", () => {
    mock.data.input = "ready";
    wrap(<><PermissionsPanel /><PermissionReminder /></>);
    expect(screen.getByText("已授权 · 未采集")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("隐私与安全 → 录屏与系统录音 → 仅系统录音 → Yulu / YuluCapture")).toBeInTheDocument();
  });
  it("does not label active system audio as idle", () => {
    mock.data.systemAudioCapturing = true;
    wrap();
    expect(screen.getByText("已授权")).toBeInTheDocument();
    expect(screen.queryByText("已授权 · 未采集")).toBeNull();
  });
  it("identifies the current notification owner when notifications are disabled", () => {
    mock.data.notifications = "denied";
    wrap();
    expect(screen.getByText("已关闭")).toBeInTheDocument();
    expect(screen.getByText("请开启 Yulu 本体的通知；旧版 Yulu Status Agent 的授权不会自动转移。")).toBeInTheDocument();
    expect(mock.open).not.toHaveBeenCalled();
  });
  it("shows notifications awaiting a decision separately from a failed audio check", () => {
    mock.data.systemAudio = "check_failed";
    wrap();
    expect(screen.getByText("尚未授权")).toBeInTheDocument();
    expect(screen.getByText("检测失败")).toBeInTheDocument();
  });
  it("offers existing users a non-blocking reminder which can be dismissed", async () => {
    const user = userEvent.setup();
    wrap(<PermissionReminder />);
    expect(screen.getByRole("link", { name: "检查权限" })).toHaveAttribute("href", "/onboarding#permissions");
    await user.click(screen.getByRole("button", { name: "暂时收起" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not nag for optional notifications or intentionally disabled voice shortcuts", () => {
    mock.data.voiceInputEnabled = false;
    wrap(<PermissionReminder />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
