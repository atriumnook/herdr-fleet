import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ArrowDown, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, Copy, FilePen, FileSearch, Globe, ListChecks, Target, Terminal, Wrench,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";

import { AgentMark } from "./AgentMark.tsx";
import { Markdown } from "./Markdown.tsx";
import { PromptCard, type PromptCardEvent } from "./PromptCard.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { turnRevision } from "../lib/turnRevision.ts";
import { useWholeOutput as useScopedOutput } from "../lib/useWholeOutput.ts";
import { turnSkills } from "../lib/skillActivity.ts";
import type { Emit } from "../ui/bubble.ts";
import type { ChatState, ConversationView, UiEvent } from "../ui/state.ts";
import type { TranscriptMessage } from "../lib/transcript.ts";
import { isLiveWorkTurn, formatWorkDuration, splitTurn, workSummary, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, planRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "../lib/goals.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { patchText } from "../../shared/patch.ts";
import { machinePath } from "../../shared/machines.ts";
import { fileUrl } from "../lib/api.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { lineDiff } from "../lib/diff.ts";
import { formatTokens } from "../lib/compose.ts";

/** The pane this chat shows, for what its rows fetch on request (a tool call's whole output). */
const ChatPaneContext = createContext<string | null>(null);
const ChatHistoryContext = createContext("");
import type { AgentStatus, ConversationPart, ConversationResponse, ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import { currentLocale, useT } from "../lib/i18n.ts";

/** Scrolling this close to the top asks for the page before it. */
const LOAD_OLDER_PX = 400;

/** What the chat draws: the pane's conversation as read, its waiting prompt, and the pane's state. */
export interface ChatViewModel {
  paneId: string;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  view: ConversationView;
  /** the view changed from an empty one: nothing was there to be "new" against */
  fresh: boolean;
  older: ConversationTurn[];
  olderCursor: string | null | undefined;
  olderState: "idle" | "loading" | "failed";
  historyId: string | undefined;
  error: { message: string; status: number | null } | null;
  loaded: boolean;
  /** turns the transcript holds on a path /tree walked away from */
  abandoned: NonNullable<ConversationResponse["abandoned"]> | null;
  sentOver: { turn: ConversationTurn; page: ConversationTurn[] } | null;
  prompt: InteractivePrompt | null;
  pendingAnswer: { promptId: string; answer: TypedAnswer } | null;
  /** an answer from the prompt's card */
  card: ChatState["card"];
  showThinking: boolean;
}

/** the prompt card's answers, and an earlier page asked for */
export type ChatViewEvent = PromptCardEvent | Extract<UiEvent, { type: "load-older-conversation" }>;

function formatTime(ts: string | null): string | null {
  if (ts === null) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

/** A quiet text button that copies and says "Copied" for a moment. */
function CopyButton({ text, label, className = "icon-button chat-copy", children }: { text: string; label: string; className?: string; children?: React.ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={copied ? t("Copied") : label} title={copied ? t("Copied") : label}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </button>
  );
}

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return <ul className="chat-checklist">{rows.map((row, index) => (
    <li key={index} className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}>
      {!row.heading && <span className="chat-checklist-box" aria-hidden="true">{row.done ? "✓" : "•"}</span>}{row.label}
    </li>
  ))}</ul>;
}

const TODO_ICONS: Record<TodoStatus, ComponentType<LucideProps>> = {
  completed: CircleCheck, in_progress: CircleDot, pending: Circle, blocked: CircleAlert, dropped: CircleSlash,
};
const TODO_LABELS: Record<TodoStatus, string> = {
  completed: "done", in_progress: "in progress", pending: "to do", blocked: "blocked", dropped: "dropped",
};

/** A todo list by phase: one row per item, its state as an icon (and in words, for screen readers). */
function TodoList({ items }: { items: TodoItem[] }) {
  const groups: { phase: string | null; items: TodoItem[] }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.phase === item.phase) group.items.push(item); else groups.push({ phase: item.phase, items: [item] });
  }
  return <div className="todo-list">{groups.map((group, index) => (
    <div key={index} className="todo-group">
      {group.phase !== null && <p className="todo-phase">{group.phase}</p>}
      <ul>{group.items.map((item, row) => {
        const Icon = TODO_ICONS[item.status];
        return <li key={row} className={`todo-item is-${item.status}`}>
          <Icon className="todo-icon" aria-hidden="true" />
          <span className="todo-label">{item.label}<span className="sr-only"> ({TODO_LABELS[item.status]})</span>{item.note && <span className="todo-note">{item.note}</span>}</span>
        </li>;
      })}</ul>
    </div>
  ))}</div>;
}

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

/** A file a tool call names: it opens in the viewer where one can, and reads as text elsewhere. */
function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  if (open === null) return <p className="chat-tool-file">{path}{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} onClick={() => open(path)}>{path}</button>{suffix}</p>;
}

/** An edit's old and new text as one diff: the unchanged lines once, the changes in place. */
function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return <pre className="chat-diff">{lines.map((line, index) =>
    <span key={index} className={line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>;
}

/** A Codex patch as a diff: each file it touches a header that opens it, then its lines coloured. */
function PatchView({ patch }: { patch: string }) {
  const sections: Array<{ file: string | null; action: string; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file !== null) { sections.push({ file: file[2]!.trim(), action: file[1]!, lines: [] }); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    if (sections.length === 0) sections.push({ file: null, action: "", lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  // the blank line a patch ends on is not part of any file
  for (const section of sections) while (section.lines.at(-1)?.trim() === "") section.lines.pop();
  const lineClass = (line: string): string | undefined =>
    line.startsWith("@@") || line.startsWith("*** Move to:") ? "chat-diff-head" : line.startsWith("+") ? "chat-diff-add" : line.startsWith("-") ? "chat-diff-del" : undefined;
  return <div className="chat-tool-io">{sections.map((section, index) => <div key={index}>
    {section.file !== null && <ToolFile path={section.file} suffix={section.action === "Update" ? undefined : ` (${section.action.toLowerCase()})`} />}
    {section.lines.length > 0 && <pre className="chat-diff">{section.lines.map((line, at) => <span key={at} className={lineClass(line)}>{line}{"\n"}</span>)}</pre>}
  </div>)}</div>;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  // a todo call shows the list as it stood after it, when the agent answered with it
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  const patch = patchText(part.input);
  if (patch !== null) return <PatchView patch={patch} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command") ?? str("cmd");
  if (command !== undefined) return <div className="chat-tool-io"><pre>{command}</pre>{(str("cwd") ?? str("description")) !== undefined && <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>}</div>;
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}<EditDiff before={oldString ?? ""} after={newString ?? ""} /></div>;
  // several edits to one file: each its own diff, in order
  if (Array.isArray(parsed["edits"]) && parsed["edits"].every((item) => item !== null && typeof item === "object")) {
    const edits = parsed["edits"] as Array<Record<string, unknown>>;
    return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}{edits.map((item, index) =>
      <EditDiff key={index} before={typeof item["old_string"] === "string" ? item["old_string"] : ""} after={typeof item["new_string"] === "string" ? item["new_string"] : ""} />)}</div>;
  }
  const editScript = str("input");
  if (editScript !== undefined) return <pre className="chat-tool-io chat-diff">{editScript.split("\n").map((line, index) => <span key={index} className={ompEditLineClass(line)}>{line}{"\n"}</span>)}</pre>;
  const content = str("content");
  if (content !== undefined) return <div className="chat-tool-io">{(str("file_path") ?? str("path")) !== undefined && <ToolFile path={(str("file_path") ?? str("path"))!} />}<pre>{content}</pre></div>;
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return <div className="chat-tool-io"><ToolFile path={path} suffix={str("pattern") !== undefined ? ` — /${str("pattern")}/` : undefined} /></div>;
  for (const [key, toRows] of [["list", phaseRows], ["todos", todoRows], ["plan", planRows], ["tasks", taskRows]] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }
  return <pre className="chat-tool-io">{part.input}</pre>;
}

function toolIcon(name: string): ComponentType<LucideProps> {
  const normalized = name.toLowerCase();
  if (normalized === "skill") return BookOpen;
  if (normalized.includes("bash") || normalized.includes("command")) return Terminal;
  if (["read", "glob", "grep"].some((item) => normalized.includes(item))) return FileSearch;
  if (normalized.includes("edit") || normalized.includes("write")) return FilePen;
  if (normalized.includes("task") || normalized.includes("agent")) return Bot;
  if (normalized.includes("web")) return Globe;
  if (normalized.includes("todo")) return ListChecks;
  if (normalized.endsWith("_goal")) return Target;
  return Wrench;
}

/** A cut output's rest, fetched when asked for: the page carries the first few thousand characters. */
function useWholeOutput(ref: string | undefined): { text: string | null; state: "idle" | "loading" | "failed"; load: () => void } {
  const paneId = useContext(ChatPaneContext);
  const machineId = useMachineId();
  const history = useContext(ChatHistoryContext);
  const url = ref === undefined || paneId === null ? null : machinePath(machineId, `pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref }).toString()}`);
  return useScopedOutput(url, history);
}

/** Images a tool returned (pi reads a picture into the result); opened with the row. */
function ToolImages({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const machineId = useMachineId();
  if (part.images === undefined || part.images.length === 0) return null;
  return <div className="chat-tool-images">{part.images.map((image) => {
    const src = machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref }).toString()}`);
    return <a key={image.ref} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={t("Open image")}><img src={src} alt={t("Attached image")} loading="lazy" /></a>;
  })}</div>;
}

/** One row of a work block: `▸ name  summary`, expanding to the call's input and output. */
function WorkRow({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const whole = useWholeOutput(part.output_ref);
  const Icon = toolIcon(part.name);
  const summary = todoCallSummary(part) ?? part.summary;
  // the list is the answer of a todo call: its raw text would say it twice
  const output = isTodoTool(part.name) && parseTodoAnswer(part.output) !== null ? "" : whole.text ?? part.output;
  return <div className={`work-row${part.error ? " is-error" : ""}`}>
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <Icon className="work-row-icon" aria-hidden="true" />
      <span className="work-row-name">{part.name}</span>
      {part.error && <span className="work-row-failed">{t("failed")}</span>}
      {summary.length > 0 && summary !== part.name && <><span className="work-row-sep" aria-hidden="true">/</span><span className="work-row-summary">{summary}</span></>}
    </button>
    {open && <div className="work-row-detail"><ToolInputView part={part} /><ToolImages paneId={paneId} part={part} />{output.length > 0 && <section className="chat-tool-output"><h4>{t(part.error ? "Error" : "Output")}</h4><pre className={`chat-tool-io${whole.text !== null ? " is-whole" : ""}`}>{output}</pre>
      {part.output_ref !== undefined && whole.text === null && <button type="button" className="btn btn-ghost chat-tool-more" disabled={whole.state === "loading"} onClick={whole.load}>
        {t(whole.state === "loading" ? "Loading the whole output…" : whole.state === "failed" ? "Couldn't load the whole output — retry" : "Show the whole output ({size} characters)", { size: formatTokens(part.output_size ?? 0) })}
      </button>}</section>}</div>}
  </div>;
}

function ThinkingRow({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <Brain className="work-row-icon" aria-hidden="true" />
      <span className="work-row-name">{t("thinking")}</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

/**
 * Everything the agent did on the way — tool calls, reasoning and the narration
 * between them — under one header ("Worked for 7s · 1 edit"). Rows stay one line
 * each until opened; the narration reads as dim prose between them.
 */
function WorkBlockView({ paneId, parts, duration, live, defaultOpen, showThinking }: { paneId: string; parts: ConversationPart[]; duration: string | null; live: boolean; defaultOpen: boolean; showThinking: boolean }) {
  const t = useT();
  const [chosenOpen, setOpen] = useState<boolean | null>(null);
  const open = chosenOpen ?? defaultOpen;
  const visible = parts.filter((part) => part.kind !== "skill" && (showThinking || part.kind !== "thinking"));
  if (visible.length === 0) return null;
  const summary = workSummary(parts);
  const title = live ? t("Working…") : duration !== null ? t("Worked for {duration}", { duration }) : t("Worked");
  return <section className={`work-block${live ? " is-live" : ""}`}>
    <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-block-title">{title}</span>
      {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
    </button>
    {open && <div className="work-block-rows">{visible.map((part, index) =>
      part.kind === "thinking" ? <ThinkingRow key={index} text={part.text} />
        : part.kind === "text" ? <div key={index} className="work-narration"><Markdown>{part.text}</Markdown></div>
          : part.kind === "tool" ? <WorkRow key={index} paneId={paneId} part={part} /> : null)}</div>}
  </section>;
}

/** Skill evidence stays visible even when the surrounding work block is folded. */
function SkillActivityList({ parts }: { parts: ConversationPart[] }) {
  const t = useT();
  const skills = turnSkills(parts);
  if (skills.length === 0) return null;
  return <div className="chat-skills" role="group" aria-label={t("Skill activity")}>
    {skills.map((skill) => <details className={`chat-skill${skill.status === "failed" ? " is-error" : ""}`} key={`${skill.evidence}:${skill.path ?? skill.name}`}>
      <summary><BookOpen aria-hidden="true" /><span className="chat-skill-name">{skill.name}</span><span className="chat-skill-status">{
        skill.evidence === "invocation"
          ? skill.status === "failed" ? t("Skill invocation failed") : skill.status === "requested" ? t("Skill requested") : t("Skill invoked")
          : skill.status === "failed" ? t("Skill read failed") : skill.status === "requested" ? t("Reading skill requested") : t("Skill instructions loaded")
      }</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
      <div className="chat-skill-detail"><p>{skill.evidence === "invocation" ? t("Recorded by the agent's Skill tool. This does not mean the skill's work is complete.") : t("The transcript records loading this skill's instructions. This does not confirm every step was followed.")}</p>
        {skill.path && <code>{skill.path}</code>}
      </div>
    </details>)}
  </div>;
}

/** The goal as this turn left it: like a skill, visible while the work block is folded. */
function GoalActivity({ goal }: { goal: GoalState }) {
  const t = useT();
  const word: Record<GoalStatus, string> = {
    active: t("in progress"), paused: t("paused"), blocked: t("blocked"), complete: t("complete"), budget_limited: t("out of budget"),
  };
  const spent = [
    goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? formatGoalTime(goal.timeUsedSeconds) : null,
    goal.tokensUsed !== null && goal.tokensUsed > 0 ? t("{n} tokens", { n: formatTokens(goal.tokensUsed) }) : null,
  ].filter((item) => item !== null).join(" · ");
  return <details className={`chat-goal is-${goal.status}`}>
    <summary><Target aria-hidden="true" /><span className="chat-goal-label">{t("Goal")}</span><span className="chat-goal-objective">{goal.objective}</span>
      <span className="chat-goal-status">{word[goal.status]}</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
    <div className="chat-goal-detail">
      <p className="chat-goal-text">{goal.objective}</p>
      {goal.blockedReason !== null && <p className="chat-goal-reason">{goal.blockedReason}</p>}
      {spent.length > 0 && <p className="chat-goal-spent">{t("Used so far: {spent}", { spent })}</p>}
    </div>
  </details>;
}

/** Image files a message mentions as `@path`, the way this app attaches them: shown as thumbnails. */
const IMAGE_MENTION = /(?:^|\s)@(\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

function UserImages({ paneId, parts, text }: { paneId: string; parts: ConversationPart[]; text: string }) {
  const t = useT();
  const machineId = useMachineId();
  const open = useContext(OpenFileContext);
  const pasted = parts.filter((part): part is Extract<ConversationPart, { kind: "image" }> => part.kind === "image");
  const mentioned = [...new Set([...text.matchAll(IMAGE_MENTION)].map((match) => match[1]!))];
  if (pasted.length === 0 && mentioned.length === 0) return null;
  return <div className="chat-user-images">
    {pasted.map((part) => {
      const src = machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: part.ref }).toString()}`);
      return <a key={part.ref} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={t("Open image")}><img src={src} alt={t("Attached image")} loading="lazy" /></a>;
    })}
    {mentioned.map((path) => {
      const src = fileUrl(path, paneId, machineId);
      return open !== null
        ? <button key={path} type="button" className="chat-user-image" title={t("Open {path}", { path })} onClick={() => open(path)}><img src={src} alt={path} loading="lazy" /></button>
        : <a key={path} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={path}><img src={src} alt={path} loading="lazy" /></a>;
    })}
  </div>;
}

interface TurnProps {
  paneId: string;
  turn: ConversationTurn;
  /** the last turn while the agent runs: its work block reads "Working…" */
  live: boolean;
  /** the newest assistant turn opens its work; older ones start folded */
  last: boolean;
  showThinking: boolean;
}

// a turn that did not change keeps its object across polls: skip re-rendering it
const Turn = memo(function Turn({ paneId, turn, live, last, showThinking }: TurnProps) {
  const t = useT();
  const time = formatTime(turn.ts);
  const compact = turn.parts.find((part): part is Extract<ConversationPart, { kind: "compact" }> => part.kind === "compact");
  if (compact !== undefined) {
    return <details className="chat-compact">
      <summary>{t("Conversation compacted")}{time !== null && <> · <time dateTime={turn.ts ?? undefined}>{time}</time></>}</summary>
      <div className="chat-compact-text"><Markdown>{compact.text}</Markdown></div>
    </details>;
  }
  // the runtime spoke, not the user: a quiet divider like a compaction, the text on request
  const notice = turn.parts.find((part): part is Extract<ConversationPart, { kind: "notice" }> => part.kind === "notice");
  if (notice !== undefined) {
    return <details className="chat-compact chat-notice">
      <summary>{t("Background result delivered")}{time !== null && <> · <time dateTime={turn.ts ?? undefined}>{time}</time></>}</summary>
      <pre className="chat-compact-text chat-notice-text">{notice.text}</pre>
    </details>;
  }
  if (turn.role === "user") {
    const text = turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");
    return <article className="chat-turn chat-turn-user">
      <UserImages paneId={paneId} parts={turn.parts} text={text} />
      {text.length > 0 && <div className="chat-bubble"><Markdown>{text}</Markdown></div>}
      {/* the skill this message invoked (omp, pi): the runtime recorded its instructions with it */}
      <SkillActivityList parts={turn.parts} />
      <div className="chat-turn-meta">{time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}{text.length > 0 && <CopyButton text={text} label={t("Copy message")} />}</div>
    </article>;
  }
  const { work, answer } = splitTurn(turn.parts);
  const answerText = answer.map((part) => part.text).join("\n\n");
  const goal = turnGoal(turn.parts);
  return <article className="chat-turn chat-turn-agent">
    <SkillActivityList parts={turn.parts} />
    {goal !== null && <GoalActivity goal={goal} />}
    {work.length > 0 && <WorkBlockView paneId={paneId} parts={work} duration={formatWorkDuration(turn.ts, turn.end_ts ?? null)} live={live} defaultOpen={last} showThinking={showThinking} />}
    {answer.map((part, index) => <Markdown key={index}>{part.text}</Markdown>)}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      <CopyButton className="chat-meta-btn" text={answerText} label={t("Copy as markdown")}>MD</CopyButton>
      <CopyButton className="chat-meta-btn" text={plainText(answerText)} label={t("Copy as plain text")}>TXT</CopyButton>
      {time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}
    </div>}
  </article>;
});

function FallbackTurn({ paneId, message }: { paneId: string; message: TranscriptMessage }) {
  if (message.role === "status") return null;
  const turn: ConversationTurn = { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
  return <Turn paneId={paneId} turn={turn} live={false} last={false} showThinking={false} />;
}

/**
 * The chat lens: the pane's conversation and its waiting prompt, as the Presenter hands them over.
 * Where the reader is (at the end or not, "New messages", the turns kept under their eyes when
 * earlier ones go in above) is the view's own. The app re-renders on every pane-status and poll;
 * an unchanged model sits those out (memo).
 */
export const ChatView = memo(function ChatView({ model, emit }: { model: ChatViewModel; emit: Emit<ChatViewEvent> }) {
  const t = useT();
  const { paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, card, showThinking } = model;
  const [newMessages, setNewMessages] = useState(false);
  /** scrolled up from the end: the way back is offered even when nothing new came */
  const [away, setAway] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** where the reader was, for earlier turns going in above them */
  const place = useRef<{ top: number; height: number } | null>(null);
  const firstOlder = useRef<ConversationTurn | undefined>(undefined);

  // a pane, or a replaced transcript, opens at its end
  useLayoutEffect(() => {
    stickToBottom.current = true; setNewMessages(false); setAway(false);
  }, [paneId, historyId]);

  // the newest page moved for a reader scrolled up: they are told, not moved
  useLayoutEffect(() => {
    if (!fresh && !stickToBottom.current) setNewMessages(true);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Older turns went in above the reader: keep the same turns under their eyes.
  useLayoutEffect(() => {
    const node = scroller.current;
    const before = firstOlder.current;
    firstOlder.current = older[0];
    if (node === null || older.length === 0 || older[0] === before || place.current === null) return;
    node.scrollTop = place.current.top + (node.scrollHeight - place.current.height);
  }, [older]);

  // Before paint and without animation: an opened conversation starts at its end
  // instead of scrolling there from the top.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [view, prompt]);

  // where the reader is after each layout, for the next page above
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null) place.current = { top: node.scrollTop, height: node.scrollHeight };
  });

  // A resized composer, a raised keyboard or a narrower window shrinks the view
  // without a scroll event; a reader at the end stays at the end, at once.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // a tap or a drag down the transcript puts a phone's keyboard away to read (lib/keyboard.ts)
  useEffect(() => {
    const node = scroller.current;
    return node === null ? undefined : dismissKeyboardOn(node);
  }, []);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    place.current = { top: node.scrollTop, height: node.scrollHeight };
    stickToBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
    setAway(!stickToBottom.current);
    if (stickToBottom.current) setNewMessages(false);
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle" && typeof olderCursor === "string") emit({ type: "load-older-conversation" });
  };
  /** the earlier page asked for by the button: where the reader is now (a fold opened since moves nothing that rendered) */
  const loadOlder = (): void => {
    const node = scroller.current;
    if (node !== null) place.current = { top: node.scrollTop, height: node.scrollHeight };
    emit({ type: "load-older-conversation" });
  };
  const scrollToBottom = (): void => {
    const node = scroller.current;
    if (node === null) return;
    node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    stickToBottom.current = true; setNewMessages(false); setAway(false);
  };
  const turns = useMemo(() => older.length > 0 ? [...older, ...view.turns] : view.turns, [older, view.turns]);
  const finishedBeforeSend = sentOver !== null && sentOver.page === view.turns ? sentOver.turn : null;
  const empty = view.source === "conversation" ? turns.length === 0 : view.messages.length === 0;

  return <ChatPaneContext.Provider value={paneId}><ChatHistoryContext.Provider value={historyId ?? ""}><div className="chat-view" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={t("conversation of {pane}", { pane: paneId })}>
    <div className="chat-transcript">
      {/* the conversation below is not all the file holds: a /tree left these behind, and pi moved
          its leaf without writing anything, so nothing here could say they were ever there. First
          in the transcript, because paging back would otherwise drop them under their own heading */}
      {view.source === "conversation" && abandoned !== null && abandoned.count > 0 && (
        <details className="chat-compact chat-abandoned">
          <summary>{t(abandoned.branches > 1
            ? abandoned.count === 1 ? "{n} earlier turn on {b} branches you navigated away from" : "{n} earlier turns on {b} branches you navigated away from"
            : abandoned.count === 1 ? "{n} earlier turn on a branch you navigated away from" : "{n} earlier turns on a branch you navigated away from",
            { n: abandoned.count, b: abandoned.branches })}</summary>
          {abandoned.summary !== null
            ? <div className="chat-compact-text"><Markdown>{abandoned.summary}</Markdown></div>
            : <p className="chat-abandoned-note">{t("pi kept them in the session file but answers from the branch you chose. Use /tree in the terminal to go back.")}</p>}
        </details>
      )}
      {/* one button in every state: swapping it for a status line of another height would shift the reader */}
      {view.source === "conversation" && typeof olderCursor === "string" && (
        <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading"} onClick={loadOlder}>
          {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
        </button>
      )}
      {view.source === "conversation" && olderCursor === null && older.length > 0 && <p className="chat-endcap">{t("beginning of conversation")}</p>}
      {view.source === "conversation"
        ? turns.map((turn, index) => {
            const last = index === turns.length - 1;
            return <RenderBoundary key={`${paneId}:${historyId ?? ""}:${turn.role}:${turn.ts ?? index}`} resetKey={turnRevision(turn)} fallback={() => <p className="chat-inline-state chat-inline-error">{t("This message can't be shown here. The terminal has it.")}</p>}>
              <Turn paneId={paneId} turn={turn} live={isLiveWorkTurn(turn, last, agentStatus, finishedBeforeSend)} last={last} showThinking={showThinking} />
            </RenderBoundary>;
          })
        : agent !== null
          ? <details className="chat-terminal-fallback"><summary>{t("Conversation unavailable — show terminal output")}</summary><pre>{view.messages.map((message) => message.text).join("\n\n")}</pre></details>
          : view.messages.map((message, index) => <FallbackTurn key={index} paneId={paneId} message={message} />)}
      {!ended && !connected && <p className="chat-inline-state">{t("reconnecting…")}</p>}
      {error !== null && <p className="chat-inline-state chat-inline-error" role="alert">{error.status === 401 ? "locked — the token gate is asking again" : error.message}</p>}
      {!loaded && error === null && <p className="chat-inline-state" role="status">{t("Loading conversation…")}</p>}
      {loaded && empty && error === null && prompt === null && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>{t("No conversation yet — say something below")}</p></div>}
      {prompt !== null && <PromptCard prompt={prompt} typedAnswer={pendingAnswer !== null && pendingAnswer.promptId === prompt.id ? pendingAnswer.answer : null} card={card} emit={emit} />}
      {ended && <p className="chat-endcap">{t("terminal ended")}</p>}
    </div>
    {newMessages ? <button type="button" className="btn chat-new-messages" onClick={scrollToBottom}>{t("New messages")} <ArrowDown aria-hidden="true" /></button>
      : away && <button type="button" className="btn chat-new-messages is-icon" aria-label={t("Jump to latest")} title={t("Jump to latest")} onClick={scrollToBottom}><ArrowDown aria-hidden="true" /></button>}
  </div>
  </ChatHistoryContext.Provider></ChatPaneContext.Provider>;
});
