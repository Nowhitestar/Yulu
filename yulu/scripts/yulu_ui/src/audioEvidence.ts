/** PCM energy is a conservative sanity check, not a speech recognizer. Keep
 * the complete timeline (including silence) for the provider's word offsets. */
export class AudioEvidence {
  private ranges: Array<{ start: number; end: number }> = [];
  durationMs = 0;
  lastVoiceMs = 0;

  append(pcm: Buffer): void {
    const base = this.durationMs;
    for (let offset = 0; offset + 1 < pcm.length; offset += 640) {
      const end = Math.min(pcm.length, offset + 640);
      let squares = 0;
      let peak = 0;
      for (let index = offset; index + 1 < end; index += 2) {
        const sample = pcm.readInt16LE(index);
        squares += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      // Below the existing caption VAD threshold to preserve quiet speech.
      if (peak < 60 || Math.sqrt(squares / ((end - offset) / 2)) < 30) continue;
      const startMs = base + offset / 32;
      const endMs = base + end / 32;
      const previous = this.ranges.at(-1);
      if (previous && startMs - previous.end <= 100) previous.end = endMs;
      else this.ranges.push({ start: startMs, end: endMs });
      this.lastVoiceMs = endMs;
    }
    this.durationMs += pcm.length / 32;
  }

  overlaps(startMs = 0, endMs = this.durationMs): boolean {
    return this.ranges.some((range) => range.start < endMs + 160 && range.end > startMs - 160);
  }
}
