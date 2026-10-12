import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";

import { AskRecapBody, askRecap } from "./ask-recap";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const questions = [
  { header: "Stack", question: "Which?" },
  { header: "Deploy", question: "Where?" },
];

describe("askRecap", () => {
  it("pairs answers with notes and marks the unanswered as skipped", () => {
    const recap = askRecap(
      { questions },
      JSON.stringify({ answers: { question_0: "Vite — fast builds" } }),
      false
    );
    expect(recap.rows).toEqual([
      { header: "Stack", answer: "Vite", note: "fast builds" },
      { header: "Deploy", answer: null, note: null },
    ]);
    expect(recap.waiting).toBe(false);
  });

  it("waits while running with no answers", () => {
    expect(askRecap({ questions }, "", true).waiting).toBe(true);
  });

  it("renders Skipped and the arrow answer", () => {
    render(
      <AskRecapBody
        input={{ questions, answers: { question_0: "Vite" } }}
        resultText=""
        running={false}
      />
    );
    expect(screen.getByText("→ Vite")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
  });
});
