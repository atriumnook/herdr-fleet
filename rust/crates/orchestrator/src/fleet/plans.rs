//! A thread's plan for the person: `planner`, `submitPlan`, `plan`, `answerPlan` and
//! `closeStalePlan` of `server/fleet/orchestrator.ts`, over L7's checks and records (`plan.rs`,
//! `protocol::plan`).
//!
//! The plan files live in the fleet's plans folder, one per lead run, written by the server only.
//! A plan file is read and written, and the run's mark of it saved, under this cluster's lock, so
//! two plans handed over at once count two versions, and an answer or a close marks the version it
//! read (ADR 0265-plans).

use std::path::{Path, PathBuf};

use protocol::{AgentRun, AgentState, Plan, PlanMark, plan_asks, plan_open};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{Orchestrator, OrchestratorError, is_live, is_thread, locked, state_name};
use crate::error::FleetError;
use crate::plan::{check_answer, plan_answer_message, prepare_plan, read_plan, write_plan};

/// What the plans keep while this server runs: nothing but the lock a plan file is read and
/// written under.
#[derive(Debug, Default)]
pub(crate) struct State {}

/// The slot of a thread's question for its coordinator in the outbox.
const NEWS: &str = "news";

impl Orchestrator {
    /// A thread's lead, which alone writes a plan for the person (`planner`).
    fn planner(&self, target: &str, group: Option<&str>) -> Result<AgentRun, FleetError> {
        let run = self.get(target, group)?;
        if !is_thread(&run) {
            return Err(FleetError::new(
                "not_a_thread",
                format!(
                    "{} is not a thread's lead; only a thread's lead writes a plan.",
                    run.name
                ),
            ));
        }
        Ok(run)
    }

    /// The file the fleet keeps the plan of the run `id` in (`planFile`).
    fn plan_file(&self, id: &str) -> PathBuf {
        self.plans_dir().join(format!("{id}.json"))
    }

    /// The plan a thread's lead hands over (`fleet plan`): checked, its code read from the thread's
    /// worktree, and kept in the fleet's plans folder in place of the one before. The thread then
    /// waits on the person until they answer it on the Fleet screen (`submitPlan`).
    pub fn submit_plan(
        &self,
        target: &str,
        value: &Value,
        group: Option<&str>,
    ) -> Result<Plan, OrchestratorError> {
        let _plans = locked(&self.inner.plans);
        let run = self.planner(target, group)?;
        let file = self.plan_file(&run.id);
        // a kept plan that cannot be read back still counted a version
        let previous = match read_plan(&file) {
            Ok(kept) => kept.map_or(0, |plan| plan.version),
            Err(_) => run.plan.as_ref().map_or(0, |mark| mark.version),
        };
        let now = self.now();
        let plan = prepare_plan(value, Path::new(&run.cwd), previous.saturating_add(1), now)?;
        write_plan(&file, &plan)?;
        let mark = PlanMark {
            version: plan.version,
            asks: asks(&plan),
            answered_at: None,
            closed_at: None,
        };
        self.change(&run.id, |run| {
            run.plan = Some(mark);
            run.updated_at = now;
        });
        Ok(plan)
    }

    /// The thread's plan as its lead last handed it over (`plan`).
    pub fn plan(&self, target: &str, group: Option<&str>) -> Result<Plan, FleetError> {
        let run = self.planner(target, group)?;
        read_plan(&self.plan_file(&run.id))?
            .ok_or_else(|| FleetError::new("no_plan", format!("{} has written no plan.", run.name)))
    }

    /// The person's answers to the plan, sent to the lead as its next task. The lead must be free:
    /// its turn ended, as for the landing steps it takes. An answer to an older version is refused
    /// (`answerPlan`).
    pub async fn answer_plan(
        &self,
        target: &str,
        value: &Value,
        group: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let run = self.planner(target, group)?;
        let file = self.plan_file(&run.id);
        let plan = self.plan(&run.id, None)?;
        let answer = check_answer(&plan, value)?;
        still_open(&plan, &run)?;
        if !is_live(&run) {
            return Err(run_ended(&run).into());
        }
        self.inner.reconcile_locks.wait_idle(&run.id).await;
        // read again after the wait: the settlement may have ended the run or handed it on
        let run = self.registry().get(&run.id).ok_or_else(|| {
            FleetError::new("run_not_found", format!("Unknown fleet agent: {}", run.id))
        })?;
        if run.replaced_by.is_some() {
            return Err(replaced(&run).into());
        }
        if !is_live(&run) {
            return Err(run_ended(&run).into());
        }
        // another answer, or a close, may have marked this version during the wait: the lead hears
        // it once (TypeScript checks only before the wait)
        if let Ok(Some(kept)) = read_plan(&file)
            && kept.version == plan.version
        {
            still_open(&kept, &run)?;
        }
        // the check that no turn is in flight and the new turn are one step, so a second answer
        // finds the lead busy (`run_busy`); the plan counts as answered once the message reached
        // the lead
        let message = plan_answer_message(&plan, &answer);
        let id = run.id.as_str();
        let sent = self
            .inner
            .outbox
            .send_now(id, &message, |text| async move {
                self.submit_when_free(id, &text, cancel).await
            })
            .await??;
        // submit answers a refusal without an error: herdr would not type into a lead on its
        // approval screen, or the prompt failed. The answers did not arrive, so the plan still
        // takes them. (a prompt typed that left the lead on an approval screen did arrive: its turn
        // is in flight)
        if sent.state == AgentState::Blocked && !self.turn_in_flight(&run.id) {
            return Err(FleetError::new(
                "agent_blocked",
                format!(
                    "The lead of {} is waiting on its screen (an approval or a question); answer it there, then send your answers again.",
                    run.name
                ),
            )
            .into());
        }
        if sent.state == AgentState::Failed {
            return Err(FleetError::new(
                "answer_not_delivered",
                format!(
                    "The answers did not reach the lead of {}: {}.",
                    run.name,
                    sent.last_error
                        .as_deref()
                        .unwrap_or("its pane refused them")
                ),
            )
            .into());
        }
        // the question the coordinator was still to hear was this plan: the person answered it
        // the answers arrived: an outbox that cannot be written does not leave the plan open for
        // them again
        if let Err(error) = self.inner.outbox.discard(&run.id, NEWS) {
            eprintln!("herdr-fleet: the outbox file could not be written: {error}");
        }
        // the lead may have handed over a newer plan meanwhile: only the version answered is marked,
        // and only while it is open (a settlement may have closed it since the answers went out)
        let _plans = locked(&self.inner.plans);
        let current = read_plan(&file).ok().flatten();
        let Some(current) = current.filter(|current| {
            current.version == plan.version && plan_open(current.answered_at, current.closed_at)
        }) else {
            return Ok(self.registry().get(&run.id).unwrap_or(run));
        };
        let answered_at = self.now();
        let mark = PlanMark {
            version: plan.version,
            asks: asks(&current),
            answered_at: Some(answered_at),
            closed_at: None,
        };
        write_plan(
            &file,
            &Plan {
                answered_at: Some(answered_at),
                answer: Some(answer),
                ..current
            },
        )?;
        let saved = self.change(&run.id, |run| run.plan = Some(mark));
        Ok(saved.unwrap_or(run))
    }

    /// A turn of the lead `id` settled after the one that wrote its plan, without the person's
    /// answers (someone sent it another task, or decided in its chat): the lead went on, and the
    /// plan, no longer what it builds to, takes no answers (`closeStalePlan`). `submitted_at` is
    /// when the turn's prompt was handed to herdr, none for a turn a restart took over. A plan file
    /// that cannot be read back or written is logged, and the plan stays open: the hook returns
    /// nothing (ADR 0264-notices, ADR 0265-plans).
    pub(crate) fn close_stale_plan(&self, id: &str, submitted_at: Option<i64>) {
        let Some(submitted_at) = submitted_at else {
            return;
        };
        let _plans = locked(&self.inner.plans);
        let Some(mark) = self
            .registry()
            .get(id)
            .and_then(|run| run.plan)
            .filter(|mark| plan_open(mark.answered_at, mark.closed_at))
        else {
            return;
        };
        let file = self.plan_file(id);
        let plan = match read_plan(&file) {
            Ok(Some(plan)) => plan,
            Ok(None) => return,
            Err(error) => {
                eprintln!("herdr-fleet: the plan of {id} stays open: {error}");
                return;
            }
        };
        if plan.version != mark.version || plan.written_at >= submitted_at {
            return;
        }
        let closed_at = self.now();
        let closed = Plan {
            closed_at: Some(closed_at),
            ..plan
        };
        if let Err(error) = write_plan(&file, &closed) {
            eprintln!("herdr-fleet: the plan file could not be written: {error}");
            return;
        }
        self.change(id, |run| {
            run.plan = Some(PlanMark {
                closed_at: Some(closed_at),
                ..mark
            });
        });
    }
}

/// How many decisions the plan asks the person for.
fn asks(plan: &Plan) -> u32 {
    u32::try_from(plan_asks(&plan.claims).len()).unwrap_or(u32::MAX)
}

/// The plan still takes answers: refused when the person answered it, or the lead went on without
/// them.
fn still_open(plan: &Plan, run: &AgentRun) -> Result<(), FleetError> {
    if plan.answered_at.is_some() {
        return Err(FleetError::new(
            "plan_answered",
            format!(
                "The person already answered version {} of the plan of {}.",
                plan.version, run.name
            ),
        ));
    }
    if plan.closed_at.is_some() {
        return Err(FleetError::new(
            "plan_closed",
            format!(
                "The lead of {} went on without answers to version {} of its plan.",
                run.name, plan.version
            ),
        ));
    }
    Ok(())
}

/// The lead ended: nothing more reaches it.
fn run_ended(run: &AgentRun) -> FleetError {
    FleetError::new(
        "run_ended",
        format!("The lead of {} has {}.", run.name, state_name(run.state)),
    )
}

/// The thread went on in a new lead run: what the person pressed goes there (`replaced`).
fn replaced(run: &AgentRun) -> FleetError {
    FleetError::new(
        "run_ended",
        format!(
            "The lead of {} failed or left no report, and the fleet started the thread again as {}; press it again there.",
            run.name,
            run.replaced_by.as_deref().unwrap_or("")
        ),
    )
}
