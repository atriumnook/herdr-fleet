import { useState, type ReactNode } from "react";
import { FolderPlus } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import { relay } from "../../ui/bubble.ts";
import type { ProjectModel, UsageCapsuleModel } from "../../ui/fleetView.ts";
import type { UiEvent } from "../../ui/state.ts";
import { t } from "../../lib/i18n.ts";
import { UsageCapsule, type UsageCapsuleEvent } from "./UsageCapsule.tsx";

export type ProjectRailEvent = Extract<UiEvent, { type: "fleet-project" | "refresh-usage" | "clear-cooldown" }>;

export interface ProjectRailModel {
  projects: ProjectModel[];
  usage: { capsules: UsageCapsuleModel[]; refreshing: boolean };
  canAct: boolean;
  now: number;
}

const DOT_WORD: Record<ProjectModel["dot"], string> = { needs: "Needs you", working: "Working", idle: "Idle", none: "" };

/**
 * The sidebar of the Fleet screen: the projects (a repository each), a new one from a folder, and
 * the usage of each account. Passive: the folder browser comes in as a slot from the Presenter.
 */
export function ProjectRail({ model, browser, emit }: { model: ProjectRailModel; browser: (pick: (path: string) => void) => ReactNode; emit: Emit<ProjectRailEvent> }) {
  // purely visual: whether the folder browser for a new project is out
  const [picking, setPicking] = useState(false);
  return (
    <nav className="fleet-rail" aria-label={t("Projects")}>
      <h2 className="fleet-rail-head">{t("Projects")}</h2>
      <div className="fleet-rail-list">
        {model.projects.map((project) => (
          <button key={project.path} type="button" className={`fleet-project${project.selected ? " is-selected" : ""}`} aria-current={project.selected ? "true" : undefined}
            onClick={() => emit({ type: "fleet-project", project: project.path })}>
            <span className="fleet-project-text"><b>{project.name}</b><span className="mono">{project.path}</span></span>
            {project.dot !== "none" && <span className={`fleet-project-dot dot-${project.dot}`} title={t(DOT_WORD[project.dot])} aria-label={t(DOT_WORD[project.dot])} />}
          </button>
        ))}
      </div>
      {picking
        ? <div className="fleet-rail-browser">{browser((path) => { setPicking(false); emit({ type: "fleet-project", project: path }); })}
            <button type="button" className="btn btn-ghost" onClick={() => setPicking(false)}>{t("Cancel")}</button></div>
        : <button type="button" className="btn fleet-new-project" disabled={!model.canAct} onClick={() => setPicking(true)}><FolderPlus aria-hidden="true" />{t("New project")}</button>}
      <section className="fleet-rail-usage" aria-label={t("Usage")}>
        <h2 className="fleet-rail-head">{t("Usage")}</h2>
        {model.usage.capsules.map((capsule) => (
          <UsageCapsule key={capsule.key} capsule={capsule} now={model.now} emit={relay<UsageCapsuleEvent, ProjectRailEvent>(emit, (_, pass) => pass({ type: "clear-cooldown", key: capsule.key }))} />
        ))}
        {model.canAct && (
          <button type="button" className="btn btn-ghost" disabled={model.usage.refreshing} onClick={() => emit({ type: "refresh-usage" })}>
            {model.usage.refreshing ? t("Refreshing…") : t("Refresh usage")}
          </button>
        )}
      </section>
    </nav>
  );
}
