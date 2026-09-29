import { describe, expect, it } from "vitest";
import { AudioEvidence } from "../src/audioEvidence.js";

function tone(ms: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(ms * 32);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI / 13) * amplitude), i * 2);
  }
  return pcm;
}

describe("AudioEvidence", () => {
  it("rejects room-tone energy, DC offset and isolated clicks", () => {
    const dc = Buffer.alloc(32_000);
    const clicks = Buffer.alloc(32_000);
    for (let i = 0; i < dc.length; i += 2) dc.writeInt16LE(600, i);
    for (let i = 0; i < clicks.length; i += 16_000) clicks.writeInt16LE(8_000, i);
    for (const pcm of [Buffer.alloc(32_000), tone(1000, 80), dc, clicks]) {
      const evidence = new AudioEvidence();
      evidence.append(pcm);
      expect(evidence.overlaps()).toBe(false);
      expect(evidence.lastVoiceMs).toBe(0);
      expect(evidence.durationMs).toBe(1000);
    }
  });

  it("retains a quiet short reply regardless of transport chunk boundaries", () => {
    const pcm = Buffer.concat([Buffer.alloc(32_000), tone(80, 240), Buffer.alloc(32_000)]);
    for (const chunkBytes of [pcm.length, 128, 478, 2560]) {
      const evidence = new AudioEvidence();
      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        evidence.append(pcm.subarray(offset, offset + chunkBytes));
      }
      expect(evidence.overlaps(1000, 1080)).toBe(true);
      expect(evidence.overlaps(0, 500)).toBe(false);
      expect(evidence.overlaps(1500, 2000)).toBe(false);
      expect(evidence.lastVoiceMs).toBe(1080);
      expect(evidence.durationMs).toBe(2080);
    }
  });

  it("does not treat invalid provider timestamps as evidence", () => {
    const evidence = new AudioEvidence(); evidence.append(tone(1000, 600));
    expect(evidence.overlaps(500, 400)).toBe(false);
    expect(evidence.overlaps(-100, 100)).toBe(false);
    expect(evidence.overlaps(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
