/**
 * The settled recap of `ask_user_question`: each question's header, the
 * answer (and its note), or "Skipped". The live questionnaire is the
 * permission card; this is what the transcript keeps afterwards.
 */
import { useTranslation } from "react-i18next";

export interface AskRecapRow {
  header: string;
  /** The selected option(s); null when skipped. */
  answer: string | null;
  note: string | null;
}

export interface AskRecap {
  rows: AskRecapRow[];
  /** True while no answer has arrived. */
  waiting: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Answers come from the merged input, else the result's JSON `answers`. */
const answersOf = (
  input: Record<string, unknown>,
  resultText: string
): Record<string, string> => {
  const merged = asRecord(input.answers);
  if (merged != null) return merged as Record<string, string>;
  try {
    const parsed = asRecord(JSON.parse(resultText));
    const answers = asRecord(parsed?.answers);
    if (answers != null) return answers as Record<string, string>;
  } catch {
    // Not JSON: no structured answers.
  }
  return {};
};

export const askRecap = (
  input: Record<string, unknown>,
  resultText: string,
  running: boolean
): AskRecap => {
  const answers = answersOf(input, resultText);
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const rows = questions.map((raw, index): AskRecapRow => {
    const question = asRecord(raw);
    const header = String(question?.header ?? question?.question ?? "");
    const answer = answers[`question_${index}`];
    if (typeof answer !== "string" || answer.length === 0)
      return { header, answer: null, note: null };
    const [selection = "", ...rest] = answer.split(" — ");
    return {
      header,
      answer: selection,
      note: rest.length > 0 ? rest.join(" — ") : null,
    };
  });
  return {
    rows,
    waiting: running && Object.keys(answers).length === 0,
  };
};

export const AskRecapBody = ({
  input,
  resultText,
  running,
}: {
  input: Record<string, unknown>;
  resultText: string;
  running: boolean;
}) => {
  const { t } = useTranslation();
  const recap = askRecap(input, resultText, running);
  if (recap.waiting)
    return (
      <p className="text-muted-foreground text-xs italic">
        {t("chat.tool.askWaiting")}
      </p>
    );
  if (recap.rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-slot="ask-recap">
      {recap.rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-0.5 text-xs">
          <span className="text-muted-foreground">{row.header}</span>
          {row.answer != null ? (
            <>
              <span className="text-foreground">{`→ ${row.answer}`}</span>
              {row.note != null ? (
                <span className="text-muted-foreground ms-3 italic">
                  {row.note}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground ms-3 italic">
              {t("chat.tool.askSkipped")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};
