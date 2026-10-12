import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { SessionTasks } from "./tasks";

const todo = (todos: Array<{ content: string; status: string }>) =>
  [
    {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "t",
          name: "todo",
          arguments: JSON.stringify({ todos }),
        },
      ],
    },
  ] as never;

describe("SessionTasks tab", () => {
  beforeAll(async () => {
    await initI18n();
  });

  it("renders nothing without tasks", () => {
    const { container } = render(<SessionTasks messages={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("is one line with progress and the current task, and opens upward", () => {
    render(
      <SessionTasks
        messages={todo([
          { content: "Read the code", status: "completed" },
          { content: "Write the tab", status: "in_progress" },
          { content: "Ship it", status: "pending" },
        ])}
      />
    );
    const toggle = screen.getByRole("button", { name: /Tasks 1 of 3/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Write the tab")).toBeTruthy();
    expect(screen.queryByText("Ship it")).toBeNull();
    const tab = document.querySelector<HTMLElement>(
      '[data-slot="composer-tasks"]'
    )!;
    // Only the top corners are rounded.
    expect(tab.className).toContain("rounded-t-[14px]");
    expect(tab.className).not.toMatch(/rounded-b|\brounded-\[/);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByText("Ship it").closest("[id]")!.id
    );
    fireEvent.keyDown(toggle, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
