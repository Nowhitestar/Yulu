// tests/web/AboutSection.test.tsx
// P3-1: the General "About" block — read-only Yulu product version + install
// source. No edit affordance: it must expose no input/button/switch.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

let versionReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    system: {
      yuluVersion: { useQuery: () => versionReturn },
    },
  },
}));

import { AboutSection } from "../../web/src/components/settings/AboutSection.js";

beforeEach(() => {
  versionReturn = { data: { version: "0.8.0", installSource: "release v0.8.0" }, isPending: false };
});

describe("AboutSection — read-only version (P3-1)", () => {
  it("renders the Yulu product version and install source", () => {
    render(<AboutSection />);
    expect(screen.getByText("关于")).toBeInTheDocument();
    expect(screen.getByText("0.8.0")).toBeInTheDocument();
    expect(screen.getByText("release v0.8.0")).toBeInTheDocument();
  });

  it("omits the install-source row when it is null (a dev checkout)", () => {
    versionReturn = { data: { version: "0.8.0", installSource: null }, isPending: false };
    render(<AboutSection />);
    expect(screen.getByText("0.8.0")).toBeInTheDocument();
    expect(screen.queryByText("安装来源")).toBeNull();
  });

  it("is strictly read-only — no input, button, switch, or select", () => {
    const { container } = render(<AboutSection />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("shows a placeholder while the version query is loading (no crash)", () => {
    versionReturn = { data: undefined, isPending: true };
    expect(() => render(<AboutSection />)).not.toThrow();
    expect(screen.getByText("关于")).toBeInTheDocument();
  });
});
