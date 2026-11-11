//! Projects: one coordinator per repository, in its main checkout; `startProject` and the
//! coordinator's lookup (`projectCoordinator`) of `server/fleet/orchestrator.ts`.

use std::path::{Path, PathBuf};

use protocol::{AgentRun, FROM_PANE, js};
use tokio_util::sync::CancellationToken;

use super::spawn::{SpawnRequest, ThreadPlace, absolute};
use super::threads::given;
use super::{Orchestrator, OrchestratorError, PROJECT_ROLE, is_live};
use crate::error::FleetError;
use crate::events::{FleetEvent, PersonEvent};
use crate::registry::make_group_id;

/// What the projects keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

impl Orchestrator {
    /// A project's coordinator: one per repository (or folder outside one), in a workspace of its
    /// own at the main checkout. A second start of the same project hands `task` to the live one.
    /// `from_pane` is the herdr pane whose conversation sent the task through its CLI, not the
    /// Fleet screen (`startProject`).
    pub async fn start_project(
        &self,
        task: &str,
        cwd: Option<&str>,
        from_pane: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        if js::trim(task).is_empty() {
            return Err(FleetError::new("missing_task", "task is required").into());
        }
        let task = match given(from_pane) {
            Some(pane) => format!("{FROM_PANE}{pane}]\n\n{task}"),
            None => task.to_owned(),
        };
        let cwd = absolute(cwd);
        let project = self
            .deps()
            .landing
            .git_root(Path::new(&cwd))
            .await
            .map_or(cwd, |repo| repo.to_string_lossy().into_owned());
        // two starts of one project at once must not both find none and start two coordinators
        self.inner
            .project_starts
            .run(PathBuf::from(&project), async {
                if let Some(live) = self.project_coordinator(&project) {
                    self.event(FleetEvent::Person(PersonEvent {
                        run: live.id.clone(),
                        project: project.clone(),
                    }));
                    return self.send(&live.id, &task, None, cancel).await;
                }
                let name = Path::new(&project)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let request = SpawnRequest {
                    role: PROJECT_ROLE.to_owned(),
                    name: Some(format!("{name} · fleet")),
                    task: Some(task.clone()),
                    cwd: Some(project.clone()),
                    depth: Some(0),
                    group: Some(make_group_id()),
                    worktree: Some(false),
                    interactive: Some(true),
                    ..SpawnRequest::default()
                };
                let place = ThreadPlace {
                    repo: Some(PathBuf::from(&project)),
                    ..ThreadPlace::default()
                };
                self.launch(request, cancel, Some(place)).await
            })
            .await
    }

    /// The live coordinator of `project`: the merges happen in the main checkout it sits on
    /// (`projectCoordinator`).
    pub(crate) fn project_coordinator(&self, project: &str) -> Option<AgentRun> {
        self.registry().all().into_iter().find(|run| {
            run.role == PROJECT_ROLE && run.project.as_deref() == Some(project) && is_live(run)
        })
    }
}
