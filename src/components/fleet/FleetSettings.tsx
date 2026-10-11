import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Minus, Plus, X } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import type { FleetSettingsModel } from "../../ui/fleetView.ts";
import type { UiEvent } from "../../ui/state.ts";
import type { FleetAgentKind, FleetEntrance, FleetSettings, RoleCandidate, RoleSettings, ThinkingLevel } from "../../../shared/fleet.ts";
import { t } from "../../lib/i18n.ts";
import { AgentMark } from "../AgentMark.tsx";
import { Segmented } from "../Segmented.tsx";

/** What the Settings page hands up: the Mediator's own events, complete. */
export type FleetSettingsEvent = Extract<UiEvent, { type: "fleet-settings-change" | "fleet-settings" | "fleet-entrance" }>;

const KINDS: readonly FleetAgentKind[] = ["claude", "codex", "cursor", "agy", "pi"];
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_CANDIDATES = 8;

type Section = "roles" | "usage" | "projects" | "limits" | "entrances";

const label = (candidate: RoleCandidate): string => (candidate.model ? `${candidate.agent}:${candidate.model}` : candidate.agent);

/**
 * The Settings page: the person's fleet.json, by section. Each change is saved at once; a text
 * field is saved when it is left or on Enter. A watch-only device sees it and changes nothing.
 */
export function FleetSettingsPage({ model, emit }: { model: FleetSettingsModel; emit: Emit<FleetSettingsEvent> }) {
  // purely visual: the section shown
  const [section, setSection] = useState<Section>("roles");
  const settings = model.settings;
  const change: Change = (patch) => emit({ type: "fleet-settings-change", patch });
  return (
    <div className="fleet-settings">
      <header className="fleet-main-head">
        <b className="fleet-main-title">{t("Fleet settings")}</b>
        {settings && <span className="fleet-main-meta mono fleet-hide-narrow">{settings.file}</span>}
        <span className="fleet-grow" />
        {model.saving && <span className="fleet-settings-status" role="status">{t("Saving…")}</span>}
        <button type="button" className="icon-button" aria-label={t("Close settings")} title={t("Close")} onClick={() => emit({ type: "fleet-settings", open: false })}><X aria-hidden="true" /></button>
      </header>
      <div className="fleet-settings-tabs">
        <Segmented label={t("Settings section")}>
          {(["roles", "usage", "projects", "limits", "entrances"] as const).map((each) => (
            <button key={each} type="button" aria-pressed={section === each} onClick={() => setSection(each)}>{t(SECTION_LABEL[each])}</button>
          ))}
        </Segmented>
      </div>
      <div className="fleet-settings-body">
        <div className="fleet-settings-column">
          {model.status === "error" && <div className="notice" role="alert">{t("Could not load the settings. {error}", { error: model.error ?? "" })}</div>}
          {model.saveError && <div className="notice" role="alert">{t("Could not save. {error}", { error: model.saveError })}</div>}
          {!model.canAct && <p className="fleet-settings-intro">{t("This device can only watch, so the settings cannot be changed here.")}</p>}
          {!settings ? (model.status !== "error" && <p className="fleet-quiet">{t("Loading settings…")}</p>) : (
            <>
              {section === "roles" && <RolesSection settings={settings} canAct={model.canAct} change={change} />}
              {section === "usage" && <UsageSection settings={settings} model={model} change={change} />}
              {section === "projects" && <ProjectsSection model={model} change={change} />}
              {section === "limits" && <LimitsSection settings={settings} canAct={model.canAct} change={change} />}
              {section === "entrances" && <EntrancesSection model={model} emit={emit} />}
              {/* Entrances writes into the CLIs' skill folders, not fleet.json */}
              {section !== "entrances" && <p className="fleet-settings-file">{t("Changes are saved to {file} as you make them.", { file: settings.file })}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SECTION_LABEL: Record<Section, string> = { roles: "Roles", usage: "Usage", projects: "Projects", limits: "Limits", entrances: "Entrances" };

type Change = (patch: Extract<FleetSettingsEvent, { type: "fleet-settings-change" }>["patch"]) => void;

function RolesSection({ settings, canAct, change }: { settings: FleetSettings; canAct: boolean; change: Change }) {
  // purely visual: the role whose candidates are being edited
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-label={t("Roles")}>
      <h2 className="fleet-settings-heading">{t("Roles")}</h2>
      <p className="fleet-settings-intro">{t("Each role tries its candidates from the top and starts on the first one whose account has usage left.")}</p>
      <div className="fleet-roles">
        {settings.roles.map((role) => (
          <RoleRow key={role.name} role={role} readOnlyAgents={settings.readOnlyAgents} open={open === role.name} canAct={canAct}
            toggle={() => setOpen(open === role.name ? null : role.name)} change={change} />
        ))}
      </div>
    </section>
  );
}

function RoleRow({ role, readOnlyAgents, open, canAct, toggle, change }: { role: RoleSettings; readOnlyAgents: FleetAgentKind[]; open: boolean; canAct: boolean; toggle: () => void; change: Change }) {
  const now = role.candidates.find((candidate) => !candidate.skip);
  const save = (candidates: RoleCandidate[], thinking?: ThinkingLevel | null) => change({ roles: { [role.name]: { candidates: candidates.map(({ agent, model }) => (model ? { agent, model } : { agent })), ...(thinking !== undefined ? { thinking } : {}) } } });
  const list = role.candidates.map(({ agent, model }) => (model ? { agent, model } : { agent }));
  const allowed = (kind: FleetAgentKind) => !role.readOnly || readOnlyAgents.includes(kind);
  const unused = KINDS.find((kind) => allowed(kind) && !list.some((candidate) => candidate.agent === kind && !candidate.model));
  return (
    <div className={`fleet-role${open ? " is-open" : ""}`}>
      <button type="button" className="fleet-role-head" aria-expanded={open} onClick={toggle}>
        <b className="fleet-role-name">{role.name}{role.changed && <span className="pill">{t("Changed")}</span>}{role.project && <span className="pill fleet-pill-project">{t("Project")}</span>}</b>
        <span className="fleet-role-candidates">
          {role.candidates.map((candidate, index) => (
            <span key={label(candidate)} className={`fleet-candidate${candidate.skip ? " is-skipped" : ""}`} title={candidate.skip}>
              {index > 0 && <span className="fleet-candidate-arrow" aria-hidden="true">→</span>}
              <AgentMark agent={candidate.agent} size={14} />{label(candidate)}
            </span>
          ))}
          {role.thinking && <span className="fleet-candidate-thinking mono">{role.thinking}</span>}
        </span>
        <span className={`fleet-role-now${now ? "" : " is-none"}`}>{now ? t("Now: {agent}", { agent: now.agent }) : t("None usable now")}</span>
        <span className="fleet-role-description">{role.description}</span>
      </button>
      {open && (
        <div className="fleet-role-editor">
          {role.project && (
            <p className="fleet-role-note">{t("This project's .herdr-fleet/fleet.json sets this role. In this project the fleet starts it on {candidates}.", { candidates: role.project.candidates.map(label).join(" → ") })}</p>
          )}
          {role.readOnly && <p className="fleet-role-note">{t("This role edits no file, so it runs only on {agents}.", { agents: readOnlyAgents.join(", ") })}</p>}
          <ol className="fleet-candidate-list">
            {role.candidates.map((candidate, index) => (
              <li key={`${index}-${label(candidate)}`} className="fleet-candidate-row">
                <span className="fleet-candidate-number mono">{index + 1}</span>
                <select className="input" aria-label={t("CLI of candidate {n}", { n: index + 1 })} value={candidate.agent} disabled={!canAct}
                  onChange={(event) => save(list.map((each, at) => (at === index ? { agent: event.target.value as FleetAgentKind, ...(each.model ? { model: each.model } : {}) } : each)))}>
                  {KINDS.map((kind) => <option key={kind} value={kind} disabled={!allowed(kind)}>{kind}</option>)}
                </select>
                <ModelField value={candidate.model ?? ""} index={index} disabled={!canAct}
                  commit={(model) => save(list.map((each, at) => (at === index ? (model ? { agent: each.agent, model } : { agent: each.agent }) : each)))} />
                <span className="fleet-candidate-actions">
                  <button type="button" className="icon-button" aria-label={t("Move candidate {n} up", { n: index + 1 })} disabled={!canAct || index === 0}
                    onClick={() => save(list.map((each, at) => (at === index - 1 ? list[index]! : at === index ? list[index - 1]! : each)))}><ArrowUp aria-hidden="true" /></button>
                  <button type="button" className="icon-button" aria-label={t("Move candidate {n} down", { n: index + 1 })} disabled={!canAct || index === list.length - 1}
                    onClick={() => save(list.map((each, at) => (at === index + 1 ? list[index]! : at === index ? list[index + 1]! : each)))}><ArrowDown aria-hidden="true" /></button>
                  <button type="button" className="icon-button" aria-label={t("Remove candidate {n}", { n: index + 1 })} disabled={!canAct || list.length === 1}
                    onClick={() => save(list.filter((_, at) => at !== index))}><X aria-hidden="true" /></button>
                </span>
                <span className={`fleet-candidate-hint${candidate.skip ? " is-skipped" : ""}`}>{candidate.skip ?? ""}</span>
              </li>
            ))}
          </ol>
          <div className="fleet-role-footer">
            <button type="button" className="btn" disabled={!canAct || !unused || list.length >= MAX_CANDIDATES} onClick={() => unused && save([...list, { agent: unused }])}><Plus aria-hidden="true" />{t("Add candidate")}</button>
            <label className="fleet-role-thinking">
              <span>{t("Thinking")}</span>
              <select className="input" value={role.changed && role.thinking !== role.defaults.thinking ? role.thinking ?? "" : ""} disabled={!canAct}
                onChange={(event) => save(list, event.target.value ? event.target.value as ThinkingLevel : null)}>
                <option value="">{role.defaults.thinking ? t("Role default ({level})", { level: role.defaults.thinking }) : t("Role default")}</option>
                {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
            <span className="fleet-grow" />
            {role.changed && <button type="button" className="btn btn-ghost" disabled={!canAct} onClick={() => change({ roles: { [role.name]: null } })}>{t("Reset to default")}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A model name, saved when the field is left or on Enter; empty is the CLI's own default. */
function ModelField({ value, index, disabled, commit }: { value: string; index: number; disabled: boolean; commit: (model: string) => void }) {
  // what is typed: the field's own until it is saved
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => { if (draft.trim() !== value) commit(draft.trim()); };
  return (
    <input className="input mono" aria-label={t("Model of candidate {n}", { n: index + 1 })} placeholder={t("CLI default")} value={draft} disabled={disabled} spellCheck={false}
      onChange={(event) => setDraft(event.target.value.replace(/\s/g, ""))} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") save(); }} />
  );
}

function UsageSection({ settings, model, change }: { settings: FleetSettings; model: FleetSettingsModel; change: Change }) {
  return (
    <section aria-label={t("Usage")}>
      <h2 className="fleet-settings-heading">{t("Usage")}</h2>
      <div className="fleet-setting">
        <div className="fleet-setting-text">
          <b>{t("Skip an account at")}</b>
          <span>{t("The fleet passes over a candidate whose account has used this share of any limit window (5 hours, a week, and so on).")}</span>
        </div>
        <Stepper value={settings.maxUsedPercent} unit="%" min={50} max={100} step={5} canAct={model.canAct} label={t("Usage limit")} set={(maxUsedPercent) => change({ maxUsedPercent })} />
        {model.accounts.length > 0 && (
          <div className="fleet-accounts">
            {model.accounts.map((account) => (
              <span key={account.key} className={`fleet-account${account.skipped ? " is-skipped" : ""}`}>{account.key} {account.usedPercent}%{account.skipped ? ` · ${t("skipped")}` : ""}</span>
            ))}
          </div>
        )}
      </div>
      <div className="fleet-setting">
        <div className="fleet-setting-text">
          <b>{t("Sit out after a rate limit")}</b>
          <span>{t("When a CLI stops at a rate limit and gives no time to resume, the fleet does not use its account for this long.")}</span>
        </div>
        <Stepper value={settings.rateLimitCooldownMinutes} unit={` ${t("min")}`} min={5} max={24 * 60} step={5} canAct={model.canAct} label={t("Cooldown")} set={(rateLimitCooldownMinutes) => change({ rateLimitCooldownMinutes })} />
      </div>
    </section>
  );
}

function ProjectsSection({ model, change }: { model: FleetSettingsModel; change: Change }) {
  return (
    <section aria-label={t("Projects")}>
      <h2 className="fleet-settings-heading">{t("Projects")}</h2>
      <p className="fleet-settings-intro">{t("A new thread's worktree has no dependencies installed. Before its lead starts, the fleet runs the project's setup command in it. The fleet runs only commands written here, never one from the repository's own files.")}</p>
      {model.projects.length === 0 && <p className="fleet-quiet">{t("No projects yet")}</p>}
      {model.projects.map((project) => (
        <div key={project.path} className="fleet-setting fleet-setting-project">
          <div className="fleet-setting-text"><b>{project.name}</b><span className="mono">{project.path}</span></div>
          <SetupField value={project.setup} name={project.name} disabled={!model.canAct} commit={(setup) => change({ projects: { [project.path]: { setup } } })} />
        </div>
      ))}
    </section>
  );
}

function SetupField({ value, name, disabled, commit }: { value: string; name: string; disabled: boolean; commit: (setup: string) => void }) {
  // what is typed: the field's own until it is saved
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => { if (draft.trim() !== value) commit(draft.trim()); };
  return (
    <input className="input mono" aria-label={t("Setup command for {name}", { name })} placeholder={t("No setup command")} value={draft} disabled={disabled} spellCheck={false}
      onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") save(); }} />
  );
}

function LimitsSection({ settings, canAct, change }: { settings: FleetSettings; canAct: boolean; change: Change }) {
  return (
    <section aria-label={t("Limits")}>
      <h2 className="fleet-settings-heading">{t("Limits")}</h2>
      <div className="fleet-setting">
        <div className="fleet-setting-text">
          <b>{t("Agents at once")}</b>
          <span>{t("The most agents that start or work at the same time. Agents that wait for you or have finished do not count.")}</span>
        </div>
        <Stepper value={settings.maxConcurrent} unit="" min={1} max={32} step={1} canAct={canAct} label={t("Agents at once")} set={(maxConcurrent) => change({ maxConcurrent })} />
      </div>
      <div className="fleet-setting">
        <div className="fleet-setting-text">
          <b>{t("Close a helper's pane when it finishes")}</b>
          <span>{t("When a helper's turn ends, the fleet closes its pane. It does not close the panes of leads and coordinators.")}</span>
        </div>
        <button type="button" className="settings-toggle" role="switch" aria-checked={settings.closeOnSettle} aria-label={t("Close a helper's pane when it finishes")} disabled={!canAct}
          onClick={() => change({ closeOnSettle: !settings.closeOnSettle })}><span className="settings-toggle-thumb" /></button>
      </div>
    </section>
  );
}

const ENTRANCE_STATE: Record<FleetEntrance["state"], string> = { installed: "Installed", missing: "Not installed", outdated: "Outdated", taken: "Another file is there" };

function EntrancesSection({ model, emit }: { model: FleetSettingsModel; emit: Emit<FleetSettingsEvent> }) {
  const { entrances } = model;
  const press = (id: FleetEntrance["id"], action: "install" | "remove") => emit({ type: "fleet-entrance", id, action });
  return (
    <section aria-label={t("Entrances")}>
      <h2 className="fleet-settings-heading">{t("Entrances")}</h2>
      <p className="fleet-settings-intro">{t("Lets the conversation of an agent CLI in a herdr pane hand work to the fleet. The fleet puts its skill, herdr-fleet, into a folder the CLI reads skills from. When you say \"ask the fleet\" in that conversation, the CLI sends the request to the coordinator of its repository.")}</p>
      {entrances.status === "error" && <div className="notice" role="alert">{t("Could not read the skill folders. {error}", { error: entrances.error ?? "" })}</div>}
      {entrances.changeError && <div className="notice" role="alert">{t("Could not change the skill folder. {error}", { error: entrances.changeError })}</div>}
      {entrances.tokenRequired && <div className="notice">{t("This server asks for a token, and the skill does not hold it. A pane can send requests only when HERDR_FLEET_TOKEN is set in it.")}</div>}
      {entrances.list.length === 0 && entrances.status !== "error" && <p className="fleet-quiet">{t("Loading settings…")}</p>}
      {entrances.list.map((entrance) => {
        const busy = entrances.busy === entrance.id;
        const off = !model.canAct || entrances.busy !== null;
        return (
          <div key={entrance.id} className="fleet-setting fleet-setting-entrance">
            <div className="fleet-setting-text">
              <b className="mono">{entrance.file}</b>
              <span className="fleet-entrance-readers">{t("Read by")} {entrance.readers.map((kind) => <span key={kind} className="fleet-entrance-reader"><AgentMark agent={kind} size={14} />{kind}</span>)}</span>
              {entrance.state === "outdated" && <span>{t("The fleet wrote this file for another fleet command or server address. Update writes it again.")}</span>}
              {entrance.state === "taken" && <span>{t("A file the fleet did not write is there. The fleet does not overwrite or remove it.")}</span>}
            </div>
            <span className={`fleet-entrance-state fleet-entrance-${entrance.state}`}>{busy ? t("Saving…") : t(ENTRANCE_STATE[entrance.state])}</span>
            {(entrance.state === "missing" || entrance.state === "outdated") && (
              <button type="button" className={entrance.state === "missing" ? "btn btn-primary" : "btn"} disabled={off} onClick={() => press(entrance.id, "install")}>{t(entrance.state === "missing" ? "Install" : "Update")}</button>
            )}
            {(entrance.state === "installed" || entrance.state === "outdated") && (
              <button type="button" className="btn" disabled={off} onClick={() => press(entrance.id, "remove")}>{t("Remove")}</button>
            )}
          </div>
        );
      })}
      <p className="fleet-settings-file">{t("The skill holds only where the fleet command is and this server's address. The CLI reads how to hand work on from the fleet guide command each time, so the skill does not need updating when herdr-fleet changes.")}</p>
    </section>
  );
}

function Stepper({ value, unit, min, max, step, canAct, label, set }: { value: number; unit: string; min: number; max: number; step: number; canAct: boolean; label: string; set: (value: number) => void }) {
  return (
    <div className="settings-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={t("Decrease {label}", { label })} disabled={!canAct || value <= min} onClick={() => set(Math.max(min, value - step))}><Minus aria-hidden="true" /></button>
      <output aria-live="polite">{value}{unit}</output>
      <button type="button" className="icon-button" aria-label={t("Increase {label}", { label })} disabled={!canAct || value >= max} onClick={() => set(Math.min(max, value + step))}><Plus aria-hidden="true" /></button>
    </div>
  );
}
