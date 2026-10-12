/**
 * When the RouteLLM notice shows on another provider's model (free accounts):
 * right after a turn fails there, and 30 minutes after it last showed (so at
 * once the first time). Five times in all, never once they switch to RouteLLM.
 */
export const ROUTELLM_NUDGE_MAX = 5;
export const ROUTELLM_NUDGE_EVERY_MS = 30 * 60_000;

export interface RouteLlmNudgeState {
  nudges: number;
  at: number | null;
  switched: boolean;
}

/** No more notices: switched to RouteLLM, or all five shown. */
export const nudgesDone = (state: RouteLlmNudgeState): boolean =>
  state.switched || state.nudges >= ROUTELLM_NUDGE_MAX;

/** When the 30-minute notice is due (epoch ms); null when done. */
export const nudgeDueAt = (state: RouteLlmNudgeState): number | null =>
  nudgesDone(state)
    ? null
    : state.at == null
      ? 0
      : state.at + ROUTELLM_NUDGE_EVERY_MS;
