import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  requireNativeHelpers,
  resolveNativeHelperPaths,
} from "../src/nativeHelpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native helper location contract", () => {
  it("resolves the exact outer App helper directory instead of nesting under runtime scripts", () => {
    expect(resolveNativeHelperPaths({
      scriptDir: "/private/tmp/Yulu.app/Contents/Resources/runtime/yulu/scripts",
      nativeHelperDir: "/private/tmp/Yulu.app/Contents/MacOS",
    })).toEqual({
      xaiKeychain: "/private/tmp/Yulu.app/Contents/MacOS/xai_keychain",
      calendarProbe: "/private/tmp/Yulu.app/Contents/MacOS/calendar_probe",
    });
  });

  it("keeps the source-tree Yulu.app fallback for direct development Host runs", () => {
    expect(resolveNativeHelperPaths({ scriptDir: "/checkout/yulu/scripts" })).toEqual({
      xaiKeychain: "/checkout/yulu/scripts/Yulu.app/Contents/MacOS/xai_keychain",
      calendarProbe: "/checkout/yulu/scripts/Yulu.app/Contents/MacOS/calendar_probe",
    });
  });

  it("accepts only an explicit production directory containing both executable helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "yulu_native_helpers_"));
    roots.push(root);
    const helperDir = join(root, "Yulu.app", "Contents", "MacOS");
    mkdirSync(helperDir, { recursive: true });
    for (const name of ["xai_keychain", "calendar_probe"]) {
      const helper = join(helperDir, name);
      writeFileSync(helper, "#!/bin/sh\nexit 0\n");
      chmodSync(helper, 0o700);
    }

    expect(requireNativeHelpers({ scriptDir: "/ignored", nativeHelperDir: helperDir }))
      .toEqual({
        xaiKeychain: join(helperDir, "xai_keychain"),
        calendarProbe: join(helperDir, "calendar_probe"),
      });

    chmodSync(join(helperDir, "calendar_probe"), 0o600);
    expect(() => requireNativeHelpers({ scriptDir: "/ignored", nativeHelperDir: helperDir }))
      .toThrow(/calendar_probe.*missing or not executable/);
  });

  it("rejects executable directories masquerading as production helper files", () => {
    const root = mkdtempSync(join(tmpdir(), "yulu_native_helper_dirs_"));
    roots.push(root);
    const helperDir = join(root, "Yulu.app", "Contents", "MacOS");
    mkdirSync(join(helperDir, "xai_keychain"), { recursive: true });
    const calendarProbe = join(helperDir, "calendar_probe");
    writeFileSync(calendarProbe, "#!/bin/sh\nexit 0\n");
    chmodSync(calendarProbe, 0o700);

    expect(() => requireNativeHelpers({ scriptDir: "/ignored", nativeHelperDir: helperDir }))
      .toThrow(/xai_keychain.*missing or not executable/);
  });
});
