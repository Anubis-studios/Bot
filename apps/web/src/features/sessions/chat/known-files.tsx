/**
 * Feeds the chat's Markdown the session's artifact files by name, so a bare
 * "report.pdf" in prose links to the real file. Renders nothing; mounted in a
 * ChatView slot.
 */
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect } from "react";

import { useCollections } from "#renderer/data/db";

import { setKnownFiles } from "../../chat/markdown/known-files";

export const SessionKnownFiles = ({ sessionId }: { sessionId: string }) => {
  const collections = useCollections();
  const { data } = useLiveQuery(
    (q) =>
      q
        .from({ a: collections.artifacts })
        .where(({ a }) => eq(a.sessionId, sessionId)),
    [collections, sessionId]
  );
  useEffect(() => {
    const byName = new Map<string, string>();
    for (const artifact of data ?? []) {
      if (artifact.kind === "link") continue;
      const name = artifact.location.split(/[/\\]/).pop();
      if (name != null && name !== "" && !byName.has(name))
        byName.set(name, artifact.location);
    }
    setKnownFiles(sessionId, byName);
  }, [data, sessionId]);
  useEffect(() => () => setKnownFiles(sessionId, new Map()), [sessionId]);
  return null;
};
