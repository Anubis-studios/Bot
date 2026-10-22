import {
  CheckpointBusyError,
  CheckpointNotFoundError,
  checkpointsDirFor,
  CheckpointStore,
} from "@abacus-ai/agent/checkpoint-store";

import { abacusBotHome } from "../../paths";
import { conflict, notFound } from "../errors";
import { impl } from "./impl";

/** Read where the agent writes: the same home, resolved per call so tests can move it. */
const store = (): CheckpointStore =>
  new CheckpointStore(checkpointsDirFor(abacusBotHome()));

const mapped = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CheckpointNotFoundError)
      throw notFound("checkpoint", id);
    if (error instanceof CheckpointBusyError)
      throw conflict("checkpoint-turn-running", error.message);
    throw error;
  }
};

export const checkpointsRouter = impl.checkpoints.router({
  list: impl.checkpoints.list.handler(({ input }) =>
    store().summaries(input.sessionId)
  ),
  diff: impl.checkpoints.diff.handler(({ input }) =>
    mapped(String(input.seq), () =>
      store().diff(input.sessionId, input.seq, input.path)
    )
  ),
  restore: impl.checkpoints.restore.handler(({ input }) =>
    mapped(String(input.seq), () =>
      store().restore(input.sessionId, input.seq, {
        ...(input.paths != null ? { paths: input.paths } : {}),
        force: input.force === true,
        record: true,
      })
    )
  ),
});
