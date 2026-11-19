import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../../src/config.js";
import { XAI_CAPTION_TEXT_DISCLOSURE_VERSION } from "../../src/captionTranslation.js";
import { HostStore } from "../../src/hostStore.js";
import { captionTranslationRouter } from "../../src/routers/captionTranslation.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(transcription: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "yulu-caption-router-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ transcription }, null, 2)}\n`, { mode: 0o600 });
  const config = new ConfigManager(configPath);
  const host = new HostStore(join(root, "host.sqlite"));
  let credentialSource: "oauth" | "api-key" | null = "oauth";
  const caller = (authorized = true) => createCaller(captionTranslationRouter, {
    uiMutationAuthorized: authorized,
    host,
    config,
    agentConnections: { selectedXaiCredentialSource: () => credentialSource },
  } as unknown as AppContext);
  return {
    config, configPath, host, caller,
    setCredential: (value: "oauth" | "api-key" | null) => { credentialSource = value; },
  };
}

describe("captionTranslation router", () => {
  it("reports caption translation off by default, with its own disclosure", async () => {
    const { caller, host } = setup({ engine: "xai" });
    host.recordDictationTextDisclosure("xai", "xai-dictation-text-v1");
    await expect(caller().status()).resolves.toEqual({
      provider: "none",
      model: "grok-4.20-0309-non-reasoning",
      audioEngine: "xai",
      credentialSource: "oauth",
      disclosure: {
        disclosureVersion: XAI_CAPTION_TEXT_DISCLOSURE_VERSION,
        data: "caption_text",
        destination: "xAI",
        accepted: false,
        acceptedVersion: null,
        decidedAt: null,
      },
      active: false,
    });
    host.close();
  });

  it("becomes active only after an explicit, authorized acceptance with the xAI engine and a connection", async () => {
    const { caller, config, configPath, host, setCredential } = setup({
      engine: "xai", captions: { translation_provider: "xai", translation_model: "grok-4.6" },
    });
    await expect(caller().status()).resolves.toMatchObject({ provider: "xai", model: "grok-4.6", active: false });
    await expect(caller(false).acceptDisclosure()).rejects.toThrow(/UI mutation bearer required/);
    await expect(caller().acceptDisclosure()).resolves.toMatchObject({
      accepted: true, disclosureVersion: XAI_CAPTION_TEXT_DISCLOSURE_VERSION,
    });
    await expect(caller().status()).resolves.toMatchObject({
      active: true,
      disclosure: { accepted: true, acceptedVersion: XAI_CAPTION_TEXT_DISCLOSURE_VERSION },
    });
    // Accepting the disclosure does not turn on dictation text.
    expect(host.getDictationTextDisclosure("xai")).toBeNull();
    expect(JSON.parse(readFileSync(configPath, "utf8")).transcription.dictation).toBeUndefined();

    setCredential(null);
    await expect(caller().status()).resolves.toMatchObject({ active: false, credentialSource: null });
    setCredential("oauth");
    config.update("transcription.engine", "local");
    await expect(caller().status()).resolves.toMatchObject({ audioEngine: "local", active: false });
    host.close();
  });

  it("validates the caption selection on write", () => {
    const { config, host } = setup({ engine: "xai" });
    expect(() => config.update("transcription.captions.translation_provider", "hermes")).toThrow();
    expect(() => config.update("transcription.captions", { translation_provider: "openclaw" })).toThrow();
    config.update("transcription.captions.translation_provider", "xai");
    expect(config.read().transcription.captions).toEqual({
      translation_provider: "xai", translation_model: "grok-4.20-0309-non-reasoning",
    });
    host.close();
  });
});
