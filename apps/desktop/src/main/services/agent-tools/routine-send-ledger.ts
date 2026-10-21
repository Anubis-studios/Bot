/**
 * What routine runs have sent, per fire and recipient, so one fire reaches
 * a person once: a second run for the same fire, or the same text again
 * from one run, is refused at the send tool rather than left to the model.
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

  /** Why this send would repeat one already made for `fire`, or null. */
  refusal(
    fire: string,
    platform: string,
    to: string,
    sessionId: string,
    message: string
  ): string | null {
    const entry = this.sent.get(this.key(fire, platform, to));
    if (entry == null) return null;
    if (entry.sessionId !== sessionId)
      return `Not sent: another run of this routine already messaged ${to} for this same scheduled moment. Do not send it again; say in your reply that it was already sent.`;
    if (entry.messages.has(normalize(message)))
      return `Not sent: this exact message already went to ${to} in this run. Do not send it again.`;
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
