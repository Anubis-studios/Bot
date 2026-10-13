import type { Transport } from "#renderer/data/transport";

type Runtime = Transport["client"]["browser"]["runtime"];

/**
 * One viewer's hold on a local file's runtime. Main counts the holders and
 * closes the view after the last lets go, so two tabs, a dock move or a
 * remount never close a view another surface still shows.
 */
export const acquireLocalFile = (
  transport: Transport,
  input: Omit<Parameters<Runtime["materializeFile"]>[0], "holder">
) => {
  const runtime = transport.client.browser.runtime;
  const holder = crypto.randomUUID();
  const promise = runtime.materializeFile({ ...input, holder });
  let released = false;
  return {
    promise,
    release: () => {
      if (released) return;
      released = true;
      // After the acquire lands, or main would hold a holder nobody releases.
      void promise
        .catch(() => undefined)
        .then(() =>
          runtime.release({
            conversationKey: input.conversationKey,
            resourceId: input.resourceId,
            holder,
          })
        )
        .catch(() => undefined);
    },
  };
};
