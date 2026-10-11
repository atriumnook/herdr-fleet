import { MessageCircleQuestion } from "lucide-react";

import "./PromptCard.css";

import { ExplainBlock } from "./QuestionGuide.tsx";
import type { PlainQuestion } from "../lib/plainQuestion.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { Explanation } from "../ui/state.ts";

/** a choice picked (it goes into the message box, not to the agent), and the Explain button */
export type AskedCardEvent = { type: "asked-pick"; index: number } | { type: "asked-explain" };

export interface AskedCardProps {
  question: PlainQuestion;
  explanation: Explanation | undefined;
  /** the message box is empty: a choice may go into it (text the person is writing is never replaced) */
  canPick: boolean;
  emit: Emit<AskedCardEvent>;
}

/**
 * A question the agent wrote at the end of its reply, found by a guess (lib/plainQuestion.ts).
 * It is the agent's own words, so the card does not say the pane needs the person, and a choice
 * only fills the message box: the person sends it.
 */
export function AskedCard({ question, explanation, canPick, emit }: AskedCardProps) {
  return (
    <section className="prompt-card asked-card" role="region" aria-label={t("Agent asked in its reply")}>
      <header className="prompt-card-header">
        <MessageCircleQuestion className="asked-card-icon" aria-hidden="true" />
        <p className="prompt-card-question">{question.question}</p>
      </header>
      {question.options.length > 0 && (
        <div className="prompt-card-options" role="group" aria-label={t("Choices")}>
          {question.options.map((option, index) => (
            <button key={index} type="button" className="prompt-card-option" disabled={!canPick} title={t("Puts this choice in the message box. Send it from there.")} onClick={() => emit({ type: "asked-pick", index })}>
              <span className="prompt-card-number">{index + 1}.</span>
              <span className="prompt-card-option-text">
                <span className="prompt-card-option-label">{option.label}</span>
                {option.description !== null && <span className="prompt-card-option-description">{option.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {question.options.length > 0 && !canPick && <p className="prompt-card-hint">{t("The message box has text. Send or clear it to pick a choice here.")}</p>}
      <ExplainBlock explanation={explanation} onExplain={() => emit({ type: "asked-explain" })} />
    </section>
  );
}
