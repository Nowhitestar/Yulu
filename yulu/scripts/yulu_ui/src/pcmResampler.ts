import type { CaptionSource } from "./localCaptionEngine.js";
import type { WavFormat } from "./realtimeTranscription.js";

const OUTPUT_RATE = 16_000;
const TAPS = 127;

/** Stateful anti-aliasing conversion. Channel ownership, filter history and
 * fractional phase survive WAV polling boundaries; delay is below 4 ms. */
export class SourceSeparatedResampler {
  private phase: number;
  private cursor = 0;
  private initialized = false;
  private readonly coefficients: Float64Array | null;
  private readonly history: Float64Array[];

  constructor(private readonly format: WavFormat, initialPhase = 0) {
    if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) throw new Error("Invalid PCM sample rate");
    this.phase = initialPhase;
    this.history = Array.from({ length: format.channels >= 2 ? 2 : 1 }, () => new Float64Array(TAPS));
    this.coefficients = format.sampleRate > OUTPUT_RATE ? this.lowPass() : null;
  }

  feed(source: Buffer): { chunks: Partial<Record<CaptionSource, Buffer>>; phase: number } {
    const frames = Math.floor(source.length / this.format.blockAlign);
    const capacity = Math.ceil((frames * OUTPUT_RATE + this.phase) / this.format.sampleRate);
    const output = this.history.map(() => Buffer.alloc(capacity * 2));
    let written = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < this.history.length; channel += 1) {
        const value = source.readInt16LE(frame * this.format.blockAlign + channel * 2);
        if (!this.initialized) this.history[channel]!.fill(value);
        this.history[channel]![this.cursor] = value;
      }
      this.initialized = true;
      this.phase += OUTPUT_RATE;
      while (this.phase >= this.format.sampleRate) {
        this.phase -= this.format.sampleRate;
        for (let channel = 0; channel < this.history.length; channel += 1) {
          const history = this.history[channel]!;
          let value = history[this.cursor]!;
          if (this.coefficients) {
            value = 0;
            for (let tap = 0; tap < TAPS; tap += 1) {
              value += this.coefficients[tap]! * history[(this.cursor - tap + TAPS) % TAPS]!;
            }
          } else if (this.format.sampleRate < OUTPUT_RATE) {
            const previous = history[(this.cursor - 1 + TAPS) % TAPS]!;
            value = previous + (value - previous) * (1 - this.phase / OUTPUT_RATE);
          }
          output[channel]!.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), written * 2);
        }
        written += 1;
      }
      this.cursor = (this.cursor + 1) % TAPS;
    }
    return {
      chunks: {
        mic: output[0]!.subarray(0, written * 2),
        ...(output[1] ? { system: output[1].subarray(0, written * 2) } : {}),
      },
      phase: this.phase,
    };
  }

  private lowPass(): Float64Array {
    const cutoff = 7_200 / this.format.sampleRate;
    const coefficients = Float64Array.from({ length: TAPS }, (_, index) => {
      const distance = index - (TAPS - 1) / 2;
      const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * index / (TAPS - 1))
        + 0.08 * Math.cos(4 * Math.PI * index / (TAPS - 1));
      return sinc * window;
    });
    const sum = coefficients.reduce((total, value) => total + value, 0);
    return coefficients.map((value) => value / sum);
  }
}
