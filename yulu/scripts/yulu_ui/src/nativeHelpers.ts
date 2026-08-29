import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export interface NativeHelperPaths {
  xaiKeychain: string;
  calendarProbe: string;
}

export function resolveNativeHelperPaths(options: {
  scriptDir: string;
  nativeHelperDir?: string;
}): NativeHelperPaths {
  const helperDir = options.nativeHelperDir
    ?? join(options.scriptDir, "Yulu.app", "Contents", "MacOS");
  return {
    xaiKeychain: join(helperDir, "xai_keychain"),
    calendarProbe: join(helperDir, "calendar_probe"),
  };
}

export function requireNativeHelpers(options: {
  scriptDir: string;
  nativeHelperDir: string;
}): NativeHelperPaths {
  const helpers = resolveNativeHelperPaths(options);
  for (const helper of Object.values(helpers)) {
    try {
      if (!statSync(helper).isFile()) throw new Error("not a file");
      accessSync(helper, constants.X_OK);
    } catch {
      throw new Error(`required native helper ${helper} is missing or not executable`);
    }
  }
  return helpers;
}
