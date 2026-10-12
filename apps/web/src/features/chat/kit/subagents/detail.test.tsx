/** Opening a sub-agent transcript renders its messages (no kit context crash). */
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeMemoryRelays,
  memoryRelay,
} from "#renderer/test-support/chat-relay";

import * as b from "../../fixtures/builders";
import { renderRelay, type Rendered } from "../../testing";
import { SubagentDetail } from "./detail";

let current: Rendered | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  closeMemoryRelays();
});

describe("SubagentDetail", () => {
  it("renders the child transcript, tools included", async () => {
    const relay = await memoryRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r"),
      b.textStart("a"),
      ...b.toolCall("parent", "delegate_task", "a", { prompt: "go" }),
      b.subagentStarted("child", "delegate", "Child", "parent", "a"),
      ...b
        .text("child-message", "assistant", "Child says hi")
        .map((event) => ({ ...event, subagentRunId: "child" })),
      ...b
        .toolCall("nested", "bash", "child-message", { command: "ls" })
        .map((event) => ({ ...event, subagentRunId: "child" })),
      b.toolResult("nested", { text: "listing" }, { subagentRunId: "child" }),
      b.subagentFinished("child", "done"),
      b.textEnd("a"),
      b.runFinished("r"),
    ]);
    const rendered = await renderRelay(relay, "session");
    current = rendered;
    const { runtime } = rendered;
    await screen.findByText("Child");
    // The Agents tab lists the handles the client reports; seed them from the card.
    const store = runtime.session(relay.threadId).hostStore;
    const handles = store.state.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "subagent" ? [part.subagent] : []
      )
    );
    store.setState((state) => ({ ...state, subagents: handles }));
    await rendered.rerender(
      <SubagentDetail
        runtime={runtime}
        threadId={relay.threadId}
        subagentRunId="child"
        workspaceRoot="/repo"
      />
    );
    expect(await screen.findByText("Child says hi")).toBeTruthy();
  });
});
