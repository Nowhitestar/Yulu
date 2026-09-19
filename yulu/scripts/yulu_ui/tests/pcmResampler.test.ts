import { describe, expect, it } from "vitest";
import { SourceSeparatedResampler } from "../src/pcmResampler.js";

function format(sampleRate: number) {
  return { dataOffset: 44, channels: 2, sampleRate, blockAlign: 4, bitsPerSample: 16 };
}

function tone(rate: number, frequency: number, seconds = 0.2) {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * 4);
  for (let frame = 0; frame < pcm.length / 4; frame += 1) {
    pcm.writeInt16LE(Math.round(12_000 * Math.sin(2 * Math.PI * frequency * frame / rate)), frame * 4);
    pcm.writeInt16LE(-1_234, frame * 4 + 2);
  }
  return pcm;
}

function rms(pcm: Buffer) {
  let energy = 0;
  // Ignore filter startup; measure the actual preserved/aliased speech band.
  for (let i = 320; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(energy / ((pcm.length - 320) / 2));
}

describe("speech PCM resampling", () => {
  it.each([44_100, 48_000])("preserves speech and rejects out-of-band aliasing at %i Hz", (rate) => {
    const speech = new SourceSeparatedResampler(format(rate)).feed(tone(rate, 1_000));
    const interference = new SourceSeparatedResampler(format(rate)).feed(tone(rate, 10_000));
    expect(rms(speech.chunks.mic!)).toBeGreaterThan(8_000);
    expect(rms(speech.chunks.mic!)).toBeLessThan(9_000);
    expect(rms(interference.chunks.mic!)).toBeLessThan(20);
    expect(speech.chunks.system!.readInt16LE(1_000)).toBe(-1_234);
    expect(speech.chunks.mic).toHaveLength(6_400);
  });

  it.each([8_000, 16_000, 44_100, 48_000])("has identical output across irregular capture chunks at %i Hz", (rate) => {
    const input = tone(rate, 1_000);
    const whole = new SourceSeparatedResampler(format(rate)).feed(input);
    const streaming = new SourceSeparatedResampler(format(rate));
    const mic: Buffer[] = [];
    const system: Buffer[] = [];
    for (let offset = 0; offset < input.length; offset += 148) {
      const result = streaming.feed(input.subarray(offset, offset + 148));
      mic.push(result.chunks.mic!);
      system.push(result.chunks.system!);
    }
    expect(Buffer.concat(mic)).toEqual(whole.chunks.mic);
    expect(Buffer.concat(system)).toEqual(whole.chunks.system);
    expect(Buffer.concat(mic)).toHaveLength(6_400);
  });

  it("leaves already sampled 16 kHz speech unchanged", () => {
    const input = tone(16_000, 3_000);
    const output = new SourceSeparatedResampler(format(16_000)).feed(input);
    for (let frame = 0; frame < input.length / 4; frame += 1) {
      expect(output.chunks.mic!.readInt16LE(frame * 2)).toBe(input.readInt16LE(frame * 4));
    }
  });
});
