/** PCM energy is a conservative sanity check, not a speech recognizer. Keep
 * the complete timeline (including silence) for the provider's word offsets. */
export class AudioEvidence {
  private ranges: Array<{ start: number; end: number }> = [];
  private pendingPcm: Buffer = Buffer.alloc(0);
  private candidateStartMs: number | null = null;
  durationMs = 0;
  lastVoiceMs = 0;

  append(pcm: Buffer): void {
    const base = this.durationMs - this.pendingPcm.length / 32;
    this.durationMs += pcm.length / 32;
    const buffered = this.pendingPcm.length ? Buffer.concat([this.pendingPcm, pcm]) : pcm;
    let offset = 0;
    // Fixed 20 ms frames keep the decision independent of WAV/network chunking.
    for (; offset + 640 <= buffered.length; offset += 640) {
      let squares = 0;
      let sum = 0;
      let low = 32767;
      let high = -32768;
      for (let index = offset; index < offset + 640; index += 2) {
        const sample = buffered.readInt16LE(index);
        squares += sample * sample;
        sum += sample;
        low = Math.min(low, sample);
        high = Math.max(high, sample);
      }
      // Remove DC offset. About -52 dBFS plus 60 ms of sustained energy rejects
      // low room tone and isolated clicks while retaining quiet, short replies.
      // The provider's speech-probability gate handles louder non-speech noise.
      const rms = Math.sqrt(Math.max(0, squares / 320 - (sum / 320) ** 2));
      if (high - low < 160 || rms < 80) {
        this.candidateStartMs = null;
        continue;
      }
      const startMs = base + offset / 32;
      const endMs = startMs + 20;
      this.candidateStartMs ??= startMs;
      if (endMs - this.candidateStartMs < 60) continue;
      const previous = this.ranges.at(-1);
      if (previous && previous.end === startMs) previous.end = endMs;
      else this.ranges.push({ start: this.candidateStartMs, end: endMs });
      this.lastVoiceMs = endMs;
    }
    this.pendingPcm = Buffer.from(buffered.subarray(offset));
  }

  overlaps(startMs = 0, endMs = this.durationMs): boolean {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return false;
    return this.ranges.some((range) => range.start < endMs + 160 && range.end > startMs - 160);
  }
}
