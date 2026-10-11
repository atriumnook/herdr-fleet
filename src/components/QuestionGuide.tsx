import { ChevronDown, Sparkles } from "lucide-react";

import "./QuestionGuide.css";

import { Markdown } from "./Markdown.tsx";
import { formatTokens } from "../lib/compose.ts";
import { t } from "../lib/i18n.ts";
import type { Explanation } from "../ui/state.ts";

export interface ExplainBlockProps {
  explanation: Explanation | undefined;
  onExplain: () => void;
}

/**
 * Under a question's card: the button that asks Claude Haiku why the agent asks and what each
 * choice leads to, and what it wrote. Nothing is asked until the button is pressed.
 */
export function ExplainBlock({ explanation, onExplain }: ExplainBlockProps) {
  if (explanation?.status === "done") {
    return (
      <section className="question-explanation" aria-label={t("Explanation")}>
        <div className="question-explanation-text"><Markdown>{explanation.text}</Markdown></div>
        <p className="question-explanation-meta">
          {explanation.model} · {t("{n} in", { n: formatTokens(explanation.tokens.input) })} · {t("{n} out", { n: formatTokens(explanation.tokens.output) })}
        </p>
      </section>
    );
  }
  const loading = explanation?.status === "loading";
  return (
    <div className="question-explain">
      <button type="button" className="btn btn-ghost question-explain-button" disabled={loading} aria-busy={loading} title={t("Asks Claude Haiku once, on your Claude plan, why the agent asks and what each choice leads to.")} onClick={onExplain}>
        <Sparkles aria-hidden="true" /> {loading ? t("Explaining…") : t("Explain")}
      </button>
      {explanation?.status === "failed" && (
        <p className="notice question-explain-error" role="alert">
          {explanation.limited ? t("Claude was not asked. {reason}", { reason: explanation.message }) : t("Could not explain. {reason}", { reason: explanation.message })}
        </p>
      )}
    </div>
  );
}

/** The person's newest message, one line until opened: a question after long work is far below it. */
export function LastInstruction({ text }: { text: string }) {
  return (
    <details className="question-instruction">
      <summary><span className="question-instruction-label">{t("Your last message")}</span> <span className="question-instruction-preview">{text.split("\n", 1)[0]}</span><ChevronDown className="question-instruction-caret" aria-hidden="true" /></summary>
      <p className="question-instruction-text">{text}</p>
    </details>
  );
}
