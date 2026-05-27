/**
 * In-memory registry of in-flight reprocess jobs (transcribe / summarize)
 * indexed by recording stem. Phase I — see spec § 4.2.
 *
 * Singleton-style: one instance lives in the AppContext for the server's
 * lifetime. Not persisted across restarts; that's an intentional Phase I
 * v1 limit.
 */

export type JobAction = "transcribe" | "summarize";
export type JobState = "idle" | "transcribing" | "summarizing" | "failed";

export interface JobStatus {
  stem: string;
  action: JobAction;
  state: JobState;
  startedAt: number;
  jobId: string;
  error?: string;
  queueEntryId?: string;
}

export class JobRegistry {
  private map = new Map<string, JobStatus>();

  set(status: JobStatus): void {
    this.map.set(status.stem, status);
  }

  get(stem: string): JobStatus | undefined {
    return this.map.get(stem);
  }

  clear(stem: string): void {
    this.map.delete(stem);
  }

  snapshot(): Map<string, JobStatus> {
    return new Map(this.map);
  }
}
