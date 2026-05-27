import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "../../web/src/components/SettingsPage.js";

describe("SettingsPage", () => {
  it("renders children", () => {
    render(<SettingsPage>{<div>row-1</div>}</SettingsPage>);
    expect(screen.getByText("row-1")).toBeInTheDocument();
  });

  it("renders the banner above children when provided", () => {
    const { container } = render(
      <SettingsPage banner={<div data-testid="bn">BANNER</div>}>
        <div>row-1</div>
      </SettingsPage>
    );
    expect(screen.getByTestId("bn")).toBeInTheDocument();
    const bannerEl = container.querySelector(".settings-banner");
    const bodyEl = container.querySelector(".settings-body");
    expect(bannerEl).not.toBeNull();
    expect(bodyEl).not.toBeNull();
    expect((bannerEl as Node).compareDocumentPosition(bodyEl as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render banner area when banner=null", () => {
    const { container } = render(<SettingsPage banner={null}><div>row-1</div></SettingsPage>);
    expect(container.querySelector(".settings-banner")).toBeNull();
  });
});
