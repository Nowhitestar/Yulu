import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeychainProviderSecretStore,
  KeychainXaiTokenStore,
  type StoredXaiCredential,
} from "../src/xaiCredentials.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("KeychainXaiTokenStore", () => {
  it("accepts only the issue-scoped direct.xai provider slot", () => {
    expect(() => new KeychainProviderSecretStore("/tmp/helper", "direct.xai")).not.toThrow();
    expect(() => new KeychainProviderSecretStore("/tmp/helper", "direct.other")).toThrow("无效的提供商钥匙串槽位");
    expect(() => new KeychainProviderSecretStore("/tmp/helper", "gateway.hermes")).toThrow("无效的提供商钥匙串槽位");
  });

  it("passes OAuth JSON over stdin and handles Keychain not-found status", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-xai-keychain-test-"));
    roots.push(root);
    const helper = join(root, "xai_keychain");
    const storage = join(root, "stored.json");
    writeFileSync(helper, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const storage = ${JSON.stringify(storage)};`,
      "const action = process.argv[2];",
      "if (action === 'read') {",
      "  if (!fs.existsSync(storage)) process.exit(44);",
      "  process.stdout.write(fs.readFileSync(storage));",
      "} else if (action === 'write') {",
      "  const chunks = [];",
      "  process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "  process.stdin.on('end', () => fs.writeFileSync(storage, Buffer.concat(chunks)));",
      "} else if (action === 'delete') {",
      "  if (!fs.existsSync(storage)) process.exit(44);",
      "  fs.rmSync(storage);",
      "} else process.exit(1);",
    ].join("\n"));
    chmodSync(helper, 0o755);
    const store = new KeychainXaiTokenStore(helper);
    const credential: StoredXaiCredential = {
      version: 1,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 123_456,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };

    await expect(store.read()).resolves.toBeNull();
    await store.write(credential);
    await expect(store.read()).resolves.toEqual(credential);
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it("passes a provider secret over stdin and exposes only configured status", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-provider-keychain-test-"));
    roots.push(root);
    const helper = join(root, "xai_keychain");
    const storage = join(root, "stored.json");
    const argvLog = join(root, "argv.json");
    writeFileSync(helper, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const storage = ${JSON.stringify(storage)};`,
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv));`,
      "const action = process.argv[2];",
      "if (action === 'read') {",
      "  if (!fs.existsSync(storage)) process.exit(44);",
      "  process.stdout.write(fs.readFileSync(storage));",
      "} else if (action === 'write') {",
      "  const chunks = [];",
      "  process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "  process.stdin.on('end', () => fs.writeFileSync(storage, Buffer.concat(chunks)));",
      "} else if (action === 'delete') {",
      "  if (!fs.existsSync(storage)) process.exit(44);",
      "  fs.rmSync(storage);",
      "} else process.exit(1);",
    ].join("\n"));
    chmodSync(helper, 0o755);
    const store = new KeychainProviderSecretStore(helper, "direct.xai");

    await expect(store.configured()).resolves.toBe(false);
    await store.write("xai-explicit-secret");
    const argv = JSON.parse(readFileSync(argvLog, "utf8")) as string[];
    expect(argv.slice(-2)).toEqual(["write", "direct.xai"]);
    expect(JSON.stringify(argv)).not.toContain("xai-explicit-secret");
    await expect(store.configured()).resolves.toBe(true);
    await expect(store.read()).resolves.toBe("xai-explicit-secret");
    await store.clear();
    await expect(store.configured()).resolves.toBe(false);
  });

  it("handles a helper that exits before consuming stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-xai-keychain-test-"));
    roots.push(root);
    const helper = join(root, "xai_keychain");
    writeFileSync(helper, "#!/bin/sh\nexit 1\n");
    chmodSync(helper, 0o755);
    const store = new KeychainXaiTokenStore(helper);

    await expect(store.write({
      version: 1,
      accessToken: "x".repeat(1_000_000),
      refreshToken: "refresh-secret",
      expiresAt: 123_456,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    })).rejects.toThrow("无法保存 xAI OAuth");
  });
});
