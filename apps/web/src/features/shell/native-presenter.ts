import type {
  BrowserRuntimeLease,
  BrowserRuntimeBounds,
  BrowserRuntimeState,
} from "@abacus-ai/contract/contracts";
import { Store } from "@tanstack/react-store";

import type { AppClient } from "#renderer/data/transport/types";

export interface NativeCandidate {
  id: string;
  lease: BrowserRuntimeLease;
  bounds(): BrowserRuntimeBounds;
  visible(): boolean;
  blocked(): boolean;
  /** Main answered with the runtime it showed: a rebuilt one has a new lease. */
  presented?(state: BrowserRuntimeState): void;
  /** Main could not show it; the candidate is not presented again until it re-registers. */
  failed?(error: unknown): void;
}
/**
 * Serializes the window's single native presentation. Capture and hide are
 * best effort; a failed present goes to its candidate, never retried blind.
 */
export const createNativePresenter = (
  runtime: AppClient["browser"]["runtime"]
) => {
  const candidates = new Map<string, NativeCandidate>();
  const captures = new Store<Record<string, string>>({});
  const owner = new Store<string | null>(null);
  let desired: string | null = null;
  let current: NativeCandidate | null = null;
  let lastBounds = "";
  let revision = 0;
  let chain = Promise.resolve();
  /** The lease main last presented for a candidate (a rebuilt runtime's). */
  const leases = new WeakMap<NativeCandidate, BrowserRuntimeLease>();
  const leaseOf = (c: NativeCandidate) => leases.get(c) ?? c.lease;
  /** Candidates whose present failed: re-presenting them every tick would only fail again. */
  const dead = new WeakSet<NativeCandidate>();
  const eligible = (c: NativeCandidate | undefined): c is NativeCandidate =>
    c != null && !dead.has(c) && c.visible() && !c.blocked();
  const safe = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch (error) {
      console.warn("Native presentation failed", error);
      return undefined;
    }
  };
  const refresh = (): Promise<void> => {
    const requested = ++revision;
    chain = chain
      .catch(() => {})
      .then(async () => {
        if (requested !== revision) return;
        const next = candidates.get(desired ?? "");
        const chosen = eligible(next)
          ? next
          : ([...candidates.values()].find(eligible) ?? null);
        const old = current;
        if (old && (old !== chosen || !eligible(old))) {
          const capture = await safe(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                runtime.capture(leaseOf(old)),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Browser capture deadline")),
                    500
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          });
          if (capture?.dataUrl && candidates.get(old.id) === old)
            captures.setState((s) => ({ ...s, [old.id]: capture.dataUrl! }));
          await safe(() =>
            runtime.hide({ lease: leaseOf(old), presentationId: old.id })
          );
          current = null;
          owner.setState(() => null);
          lastBounds = "";
        }
        if (
          requested !== revision ||
          !chosen ||
          candidates.get(chosen.id) !== chosen ||
          !eligible(chosen)
        )
          return;
        const bounds = Object.fromEntries(
          Object.entries(chosen.bounds()).map(([k, v]) => [k, Math.round(v)])
        ) as unknown as BrowserRuntimeBounds;
        const signature = JSON.stringify(bounds);
        if (current !== chosen || signature !== lastBounds) {
          let presented: BrowserRuntimeState | undefined;
          try {
            presented = await runtime.present({
              lease: leaseOf(chosen),
              presentationId: chosen.id,
              bounds,
            });
          } catch (error) {
            dead.add(chosen);
            if (current === chosen) {
              current = null;
              owner.setState(() => null);
              lastBounds = "";
            }
            chosen.failed?.(error);
            return;
          }
          if (presented?.lease) {
            leases.set(chosen, presented.lease);
            chosen.presented?.(presented);
          }
          if (
            presented &&
            (requested !== revision ||
              candidates.get(chosen.id) !== chosen ||
              !eligible(chosen))
          ) {
            await safe(() =>
              runtime.hide({
                lease: leaseOf(chosen),
                presentationId: chosen.id,
              })
            );
            return;
          }
          if (presented && requested === revision) {
            current = chosen;
            owner.setState(() => chosen.id);
            lastBounds = signature;
          }
        }
      });
    return chain;
  };
  return {
    captures,
    owner,
    refresh,
    activate(id: string) {
      desired = id;
      return refresh();
    },
    register(candidate: NativeCandidate) {
      const previous = candidates.get(candidate.id);
      const shown = previous && leaseOf(previous);
      // A surface catching up with the lease main rebuilt is the same view.
      const equivalent =
        shown &&
        !dead.has(previous) &&
        shown.conversationKey === candidate.lease.conversationKey &&
        shown.resourceId === candidate.lease.resourceId &&
        shown.generation === candidate.lease.generation;
      candidates.set(candidate.id, candidate);
      if (!equivalent) desired = candidate.id;
      if (equivalent && current === previous) current = candidate;
      void refresh();
      return () => {
        if (candidates.get(candidate.id) === candidate)
          candidates.delete(candidate.id);
        void refresh();
      };
    },
  };
};
export type NativePresenter = ReturnType<typeof createNativePresenter>;
const presenters = new WeakMap<AppClient, NativePresenter>();
export const nativePresenterFor = (client: AppClient): NativePresenter => {
  let presenter = presenters.get(client);
  if (!presenter) {
    presenter = createNativePresenter(client.browser.runtime);
    presenters.set(client, presenter);
  }
  return presenter;
};
