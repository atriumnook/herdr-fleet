import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AgentStatus, ConversationMetadata, SlashCommand } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { Composer, type ComposerEvent, type ComposerModel } from "../components/Composer.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import { quickReplyButtons, useSettings } from "../lib/settings.ts";
import type { Emit } from "./bubble.ts";
import type { ComposerAttachment, Lens, UiEvent } from "./state.ts";
import { useSelected } from "./presenter.ts";

export type ComposerUpEvent = ComposerEvent | Extract<UiEvent, { type: "completions-open" | "attachments-close" }>;

/** nothing yet: the same empty lists each render */
const NO_COMMANDS: SlashCommand[] = [];
const NO_FILES: string[] = [];
const NO_ATTACHMENTS: ComposerAttachment[] = [];

export interface ComposerPresenterProps {
  paneId: string;
  connected: boolean;
  autoFocus: boolean;
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  metadata: ConversationMetadata | null;
  queueMode: boolean;
  answerHint: string | null;
  suggestion: string | null;
  /** which of the state's chats this composer sends for: the pane's (default) or the one beside */
  lens?: Lens;
  emit: Emit<ComposerUpEvent>;
}

/**
 * The composer's Presenter, inside the pane's terminal (not yet migrated): the pane's draft, what
 * it offers to complete, the files attached and what its last send came to, each read apart, with
 * the settings that shape the box. It reads the draft back and the commands as it opens, and as
 * it goes, the files it attached go with it and its `@` names no file any more.
 */
export function ComposerPresenter({ paneId, connected, autoFocus, agent, agentStatus, metadata, queueMode, answerHint, suggestion, lens = "main", emit: up }: ComposerPresenterProps) {
  // what this composer sends answers its own chat's prompt
  const emit = useMemo<Emit<ComposerUpEvent>>(() => (lens === "main" ? up : (event) => up({ ...event, lens } as ComposerUpEvent)), [lens, up]);
  const machineId = useMachineId();
  const owner = paneStorageId(machineId, paneId);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useLayoutEffect(() => emitRef.current({ type: "composer-draft", owner, change: { kind: "read" } }), [owner]);
  useEffect(() => {
    emitRef.current({ type: "completions-open", machineId, paneId });
    return () => {
      // opened again, the box's `@` is searched anew; leaving the pane leaves its attachments, uploads not yet started included
      emitRef.current({ type: "file-query", machineId, paneId, query: null });
      emitRef.current({ type: "attachments-close", owner });
    };
  }, [machineId, owner, paneId]);
  const draft = useSelected((state) => state.drafts.composer[owner]);
  const settled = useSelected((state) => state.drafts.settled[owner]);
  const outcome = useSelected((state) => state.sends.outcomes[`composer:${owner}`]);
  const commands = useSelected((state) => (state.completions.commands?.machineId === machineId && state.completions.commands.paneId === paneId ? state.completions.commands.list : NO_COMMANDS));
  const files = useSelected((state) => (state.completions.files.machineId === machineId && state.completions.files.paneId === paneId ? state.completions.files.list : NO_FILES));
  const slashUsage = useSelected((state) => state.completions.slashUsage);
  const attachments = useSelected((state) => state.attachments.lists[owner] ?? NO_ATTACHMENTS);
  const { settings } = useSettings();
  const quickReplies = useMemo(() => (settings.showQuickReplies ? quickReplyButtons(settings) : null), [settings]);
  const model: ComposerModel = {
    machineId, paneId, owner, connected, autoFocus, agent, agentStatus, metadata, queueMode, answerHint, suggestion,
    text: draft?.text ?? "", draftRead: draft !== undefined, sending: draft?.sending ?? false, settled, outcome, commands, files, slashUsage, attachments,
    enterSends: settings.enterSends, showSuggestionChip: settings.showSuggestionChip, quickReplies,
  };
  return <Composer model={model} emit={emit} />;
}
