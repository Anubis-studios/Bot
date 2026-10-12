import { useState } from "react";

import { useThreadHost } from "../../runtime/host";
import type { ChatRuntime } from "../../runtime/runtime";
import {
  ChatViewProvider,
  createInlineRegistry,
  SubagentScope,
} from "../context";
import { KitPartsProvider, MessageScope } from "../message-scope";
import { SessionUI } from "../ui";
export const SubagentDetail = ({
  runtime,
  threadId,
  subagentRunId,
  workspaceRoot = null,
  onOpenFile,
  onOpenDiff,
}: {
  runtime: ChatRuntime;
  threadId: string;
  subagentRunId: string;
  /** The session's checkout, so relative paths and attachments resolve. */
  workspaceRoot?: string | null;
  onOpenFile?: (absPath: string) => void;
  onOpenDiff?: (path: string, toolKey?: string) => void;
}) => {
  const session = runtime.session(threadId);
  const chat = useThreadHost(session);
  const [inline] = useState(createInlineRegistry);
  const subagent = chat.subagents.find((s) => s.id === subagentRunId);
  if (!subagent) return null;
  return (
    <ChatViewProvider
      value={{
        runtime,
        threadId,
        session,
        skin: "session",
        composer: {
          mode: "full",
          placeholder: "",
          attachmentsBase: null,
          showModeChip: false,
          model: null,
        },
        slots: {},
        workspaceRoot,
        onOpenFile,
        onOpenDiff,
        focused: false,
        notchEnabled: false,
        inline,
      }}
    >
      <KitPartsProvider value={SessionUI}>
        <SessionUI.Provider chat={chat}>
          <SubagentScope value={subagentRunId}>
            <div className="flex flex-col gap-4 p-4">
              {subagent.messages.map((message) => (
                <MessageScope
                  key={message.id}
                  value={{
                    id: message.id,
                    role: message.role,
                    streaming: subagent.status === "running",
                  }}
                >
                  <SessionUI.Message message={message} />
                </MessageScope>
              ))}
            </div>
          </SubagentScope>
        </SessionUI.Provider>
      </KitPartsProvider>
    </ChatViewProvider>
  );
};
