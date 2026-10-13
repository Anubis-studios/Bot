/**
 * The scheduler half of cron: a minute tick that fires due jobs. What a run
 * actually does (spawn a session, send the prompt) is injected by the host.
 * A fire due while the network is down, or slept through, is held (on disk,
 * so a restart keeps it) and runs once when the network is back.
 */
import {
  dueJobs,
  getJob,
  heldJobs,
  missedJobs,
  recordRun,
  retireOnceJob,
  setHeld,
} from "./cron-store";
import { ROUTINE_RESULTS } from "./routine-attempts";

type RunJob = (jobId: string, trigger: "schedule") => Promise<void>;

/** Whether a run may start now; probes when its answer is stale. */
type NetworkReady = () => Promise<boolean>;

/** A gap between ticks longer than this is a sleep (or a stall), not drift. */
const MISSED_TICK_GAP_MS = 2 * 60_000;

export class CronScheduler {
  /** Housekeeping the host wants once a minute, before the due jobs fire. */
  private onMinute: (() => void) | null = null;

  private cronTimer: NodeJS.Timeout | null = null;
  /** Last minute fired, so two ticks in one minute cannot double-fire. */
  private lastCronMinute = "";
  private lastTickAt: number | null = null;
  private releasing: Promise<void> | null = null;

  constructor(
    private readonly runJob: RunJob,
    private readonly networkReady: NetworkReady = async () => true,
    /** Told whenever the held set changes, for the routine list. */
    private readonly onHeldChange: () => void = () => {}
  ) {}

  everyMinute(callback: () => void): void {
    this.onMinute = callback;
  }

  /** Whether this job is held until the network is back. */
  isHeld(jobId: string): boolean {
    return getJob(jobId)?.heldSince != null;
  }

  /**
   * Ticks every 20 seconds, not 60: a minute interval drifts and a late tick
   * would skip that minute's jobs. Firing is keyed on the minute string.
   */
  start(): void {
    if (this.cronTimer != null) return;

    this.cronTimer = setInterval(() => {
      void this.tick();
    }, 20_000);

    this.cronTimer.unref?.();
  }

  stop(): void {
    if (this.cronTimer == null) return;

    clearInterval(this.cronTimer);
    this.cronTimer = null;
  }

  /** The network is back (or the machine woke): run what was held, once each. */
  async release(): Promise<void> {
    if (heldJobs().length === 0) return;
    if (this.releasing != null) return this.releasing;
    this.releasing = (async () => {
      if (!(await this.networkReady())) return;
      const jobs = heldJobs();
      for (const job of jobs) setHeld(job.id, null);
      this.onHeldChange();
      for (const job of jobs) {
        if (!job.enabled) continue;
        await this.fire(job.id, job.runAt != null);
      }
    })();
    try {
      await this.releasing;
    } finally {
      this.releasing = null;
    }
  }

  async tick(now: Date = new Date()): Promise<void> {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (minute === this.lastCronMinute) return;

    this.lastCronMinute = minute;
    const lastTickAt = this.lastTickAt;
    this.lastTickAt = now.getTime();

    try {
      this.onMinute?.();
    } catch (err) {
      console.error("[cron] minute maintenance failed:", err);
    }

    const due = dueJobs(now);
    // Fires slept through are held like offline ones and run once below.
    const missed =
      lastTickAt != null && now.getTime() - lastTickAt > MISSED_TICK_GAP_MS
        ? missedJobs(new Date(lastTickAt), now)
        : [];
    const dueIds = new Set(due.map((job) => job.id));
    for (const job of missed)
      if (!dueIds.has(job.id) && job.heldSince == null)
        setHeld(job.id, now.getTime());

    if (
      (due.length > 0 || heldJobs().length > 0) &&
      !(await this.networkReady())
    ) {
      for (const job of due) {
        // Its next fire came with the network still down: the held one is
        // skipped, said so, and this one waits in its place.
        if (job.heldSince != null && job.runAt == null)
          recordRun(job.id, ROUTINE_RESULTS.skippedOffline, "schedule", {
            kind: "skipped-offline",
          });
        if (job.heldSince == null || job.runAt == null)
          setHeld(job.id, now.getTime());
      }
      this.onHeldChange();
      return;
    }

    for (const job of due) {
      // A due fire is the same run a held one would have been.
      if (job.heldSince != null) setHeld(job.id, null);
      await this.fire(job.id, job.runAt != null);
    }
    if (missed.length > 0) this.onHeldChange();
    await this.release();
  }

  private async fire(jobId: string, once: boolean): Promise<void> {
    // Retire before the run: a run longer than a tick would fire twice.
    if (once) retireOnceJob(jobId);
    try {
      await this.runJob(jobId, "schedule");
    } catch (err) {
      // One failing job must not stop the others from firing.
      recordRun(
        jobId,
        `failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "schedule",
        { kind: "start-failed" }
      );
    }
  }
}
