import { describe, it, expect } from "vitest";
import { computeHealthState } from "../../../web/src/hooks/useDaemonHealthState";

describe("computeHealthState", () => {
  it("returns 'loading' when data is undefined", () => {
    expect(computeHealthState(undefined)).toBe("loading");
  });
  it("returns 'loading' when array is empty", () => {
    expect(computeHealthState([])).toBe("loading");
  });
  it("returns 'ok' when all daemons are running", () => {
    expect(
      computeHealthState([
        { name: "a", status: "running" },
        { name: "b", status: "running" },
      ]),
    ).toBe("ok");
  });
  it("returns 'ok' when a loaded on-demand daemon is idle", () => {
    expect(
      computeHealthState([
        { name: "a", status: "running" },
        { name: "b", status: "idle" },
      ]),
    ).toBe("ok");
  });
  it("returns 'warn' when one is stopped but none crashed", () => {
    expect(
      computeHealthState([
        { name: "a", status: "running" },
        { name: "b", status: "stopped" },
      ]),
    ).toBe("warn");
  });
  it("returns 'crit' when any is crashed (even if others are running)", () => {
    expect(
      computeHealthState([
        { name: "a", status: "running" },
        { name: "b", status: "crashed" },
        { name: "c", status: "running" },
      ]),
    ).toBe("crit");
  });
  it("returns 'crit' when both stopped and crashed are present", () => {
    expect(
      computeHealthState([
        { name: "a", status: "stopped" },
        { name: "b", status: "crashed" },
      ]),
    ).toBe("crit");
  });
  it("treats 'unknown' status as warn (defensive)", () => {
    expect(
      computeHealthState([
        { name: "a", status: "running" },
        { name: "b", status: "unknown" },
      ]),
    ).toBe("warn");
  });
});
