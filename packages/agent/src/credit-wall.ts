/**
 * The account's credit wall as the agent process last heard it: when the
 * Abacus credits ran out, and whether the user then chose to keep going on
 * the free models. The desktop owns it (one record per profile, shared by
 * chats, bots and routines), says so at spawn (ABACUSAI_BOT_CREDIT_WALL) and
 * after every change (the `credit_wall` command). A wall this process meets
 * first is noted here at once, before the desktop's copy comes back.
 */

/** How long a wall, and a free-lane choice made at it, hold: a day. */
export const CREDIT_WALL_TTL_MS = 24 * 60 * 60_000;

export interface CreditWallState {
  /** When Abacus last refused for credits, epoch ms; null when not out. */
  exhaustedAt: number | null;
  /** When the user chose the free models at the wall; null when not. */
  freeLaneChosenAt: number | null;
}

const stamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

const parse = (raw: unknown): CreditWallState | null => {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof CreditWallState, unknown>>;
  return {
    exhaustedAt: stamp(value.exhaustedAt),
    freeLaneChosenAt: stamp(value.freeLaneChosenAt),
  };
};

const fromEnv = (raw: string | undefined): CreditWallState => {
  try {
    return (
      parse(raw != null && raw !== "" ? JSON.parse(raw) : null) ?? {
        exhaustedAt: null,
        freeLaneChosenAt: null,
      }
    );
  } catch {
    return { exhaustedAt: null, freeLaneChosenAt: null };
  }
};

let state = fromEnv(process.env.ABACUSAI_BOT_CREDIT_WALL);

/** The desktop's record; an unreadable one leaves the last. */
export function setHostCreditWall(next: unknown): void {
  state = parse(next) ?? state;
}

export const creditWallState = (): CreditWallState => state;

const live = (at: number | null, now: number): boolean =>
  at != null && now - at < CREDIT_WALL_TTL_MS;

/** Abacus refused for credits within the day. */
export const creditWallActive = (now = Date.now()): boolean =>
  live(state.exhaustedAt, now);

/** The user chose the free models at this wall, within the day. */
export const freeLaneChosen = (now = Date.now()): boolean =>
  creditWallActive(now) && live(state.freeLaneChosenAt, now);

/** Abacus just refused for credits; a choice made at an older wall stands. */
export function noteCreditWall(now = Date.now()): void {
  if (!creditWallActive(now)) state = { ...state, exhaustedAt: now };
}

/** Abacus answered again: the credits are back and the wall is gone. */
export function noteCreditsBack(): void {
  state = { exhaustedAt: null, freeLaneChosenAt: null };
}
