/**
 * What routine runs have sent, per fire and recipient, so one fire reaches
 * a person once: a second run for the same fire, or the same text again
 * from one run, is skipped at the send tool (and said so), rather than left
 * to the model.
 */

interface Sent {
  sessionId: string;
  messages: Set<string>;
  at: number;
}

/** Long past any fire a run could still be answering. */
const KEPT_MS = 48 * 60 * 60_000;

const normalize = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

export class RoutineSendLedger {
  private readonly sent = new Map<string, Sent>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(fire: string, platform: string, to: string): string {
    return [fire, platform, normalize(to)].join("\u0000");
  }

  /**
   * The note for a send that would repeat one already made for `fire` (it
   * is skipped, not failed), or null when it is new.
   */
  repeat(
    fire: string,
    platform: string,
    to: string,
    sessionId: string,
    message: string
  ): string | null {
    const entry = this.sent.get(this.key(fire, platform, to));
    if (entry == null) return null;
    if (entry.sessionId !== sessionId)
      return `Skipped: ${to} already got a message from this routine for this same scheduled moment, so it was not sent twice. Say in your reply that it was already sent.`;
    if (entry.messages.has(normalize(message)))
      return `Skipped: this exact message already went to ${to} in this run, so it was not sent twice.`;
    return null;
  }

  record(
    fire: string,
    platform: string,
    to: string,
    sessionId: string,
    message: string
  ): void {
    const at = this.now();
    for (const [key, entry] of this.sent)
      if (at - entry.at > KEPT_MS) this.sent.delete(key);
    const key = this.key(fire, platform, to);
    const entry = this.sent.get(key) ?? {
      sessionId,
      messages: new Set<string>(),
      at,
    };
    entry.messages.add(normalize(message));
    this.sent.set(key, entry);
  }
}
