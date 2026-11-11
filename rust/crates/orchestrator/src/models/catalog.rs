//! Each CLI's list of its models, asked once in a while and kept (`ModelCatalog`,
//! `server/fleet/models.ts`).
//!
//! The time a list is kept is read from the [`Clock`], as TypeScript's test passes `now`; the
//! spawn's wait is tokio's (ADR 0242-phase-3-split, "非同期と時刻").

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use child_process::Env;
use protocol::{FleetAgentKind, ModelListing, model_listed};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{ListOptions, ModelSource, source_for};
use crate::{Clock, SystemClock};

/// How long a list is kept (`TTL_MS`, `server/fleet/models.ts:7`).
const TTL_MS: i64 = 10 * 60_000;

/// A CLI that failed is not asked again for this long (`FAILURE_TTL_MS`,
/// `server/fleet/models.ts:9`).
const FAILURE_TTL_MS: i64 = 60_000;

/// The longest a spawn waits for a CLI's list: past it the model is let through
/// (`SPAWN_WAIT_MS`, `server/fleet/models.ts:11`).
const SPAWN_WAIT: Duration = Duration::from_secs(3);

/// Where the catalog runs the CLIs, and what a test stands in for.
pub struct CatalogOptions {
    /// the folder holding a folder per CLI (`<stateDir>/model-list`), each emptied before the CLI
    /// runs in it
    pub work_dir: PathBuf,
    /// the server's environment, of which each CLI gets only what it needs
    pub env: Env,
    /// what the time a list is kept is read from
    pub clock: Arc<dyn Clock>,
    /// the longest [`ModelCatalog::unknown`] waits for a CLI's list
    pub spawn_wait: Duration,
    /// each kind's list; [`source_for`] unless told otherwise
    pub sources: Arc<dyn Fn(FleetAgentKind) -> Option<ModelSource> + Send + Sync>,
}

impl CatalogOptions {
    /// The catalog of `server/fleet/models.ts` for the CLIs' folders under `work_dir`, given the
    /// server's `env`: the system's clock, a wait of 3 seconds, and each CLI's own list.
    pub fn new(work_dir: impl Into<PathBuf>, env: Env) -> Self {
        Self {
            work_dir: work_dir.into(),
            env,
            clock: Arc::new(SystemClock),
            spawn_wait: SPAWN_WAIT,
            sources: Arc::new(|kind| Some(source_for(kind))),
        }
    }
}

/// Each CLI's list of its models (`ModelCatalog`, `server/fleet/models.ts:14`). A list is kept
/// for 10 minutes, a failure for 1; one read per CLI is under way at a time, and the lookups made
/// meanwhile share it. Clones share the lists.
#[derive(Clone)]
pub struct ModelCatalog {
    inner: Arc<Inner>,
}

struct Inner {
    work_dir: PathBuf,
    env: Env,
    clock: Arc<dyn Clock>,
    spawn_wait: Duration,
    sources: Arc<dyn Fn(FleetAgentKind) -> Option<ModelSource> + Send + Sync>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    kept: HashMap<FleetAgentKind, Kept>,
    asking: HashMap<FleetAgentKind, Asking>,
    /// the number the next read gets
    next: u64,
}

struct Kept {
    at: i64,
    listing: ModelListing,
}

/// A read under way: its number, so a read that ends after a fresh one took its place does not
/// remove the fresh one's entry, and where its listing arrives.
struct Asking {
    number: u64,
    answer: watch::Receiver<Option<ModelListing>>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        // the state stays whole whatever panicked while it was held: each change is one insert
        // or remove
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Removes its read's entry from `asking` once the read has ended, or panicked, unless a fresh
/// read took the place meanwhile (`ask.finally`, `server/fleet/models.ts:50`).
struct Finished {
    inner: Arc<Inner>,
    agent: FleetAgentKind,
    number: u64,
}

impl Drop for Finished {
    fn drop(&mut self) {
        let mut state = self.inner.state();
        if state
            .asking
            .get(&self.agent)
            .is_some_and(|asking| asking.number == self.number)
        {
            state.asking.remove(&self.agent);
        }
    }
}

enum Start {
    Kept(ModelListing),
    Waiting(watch::Receiver<Option<ModelListing>>),
}

impl ModelCatalog {
    pub fn new(options: CatalogOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                work_dir: options.work_dir,
                env: options.env,
                clock: options.clock,
                spawn_wait: options.spawn_wait,
                sources: options.sources,
                state: Mutex::default(),
            }),
        }
    }

    /// `agent`'s list. A CLI that cannot be asked gives an empty listing with the reason, kept
    /// for a minute; one that lists nothing counts as one that cannot be asked. `fresh` asks anew
    /// whatever is kept or under way (`list`, `server/fleet/models.ts:29`).
    ///
    /// The read starts when this is called, not when the future is first polled, and runs in a
    /// task of its own: a caller that stops waiting leaves it to finish and be kept, as a
    /// JavaScript promise does.
    ///
    /// # Panics
    ///
    /// When called outside a tokio runtime, and a read has to start.
    pub fn list(
        &self,
        agent: FleetAgentKind,
        fresh: bool,
    ) -> impl Future<Output = ModelListing> + Send + 'static {
        let start = self.start(agent, fresh);
        async move {
            match start {
                Start::Kept(listing) => listing,
                Start::Waiting(mut answer) => {
                    let listing = answer
                        .wait_for(Option::is_some)
                        .await
                        .map(|listing| listing.clone());
                    match listing {
                        Ok(Some(listing)) => listing,
                        // the read panicked: nothing was kept, and the next lookup asks again
                        _ => ModelListing {
                            agent,
                            models: Vec::new(),
                            complete: false,
                            error: Some(format!("{} could not be asked", agent.name())),
                        },
                    }
                }
            }
        }
    }

    fn start(&self, agent: FleetAgentKind, fresh: bool) -> Start {
        let (number, send) = {
            let mut state = self.inner.state();
            if !fresh {
                if let Some(kept) = state.kept.get(&agent) {
                    let ttl = if kept.listing.error.is_some() {
                        FAILURE_TTL_MS
                    } else {
                        TTL_MS
                    };
                    if self.inner.clock.now_ms() - kept.at < ttl {
                        return Start::Kept(kept.listing.clone());
                    }
                }
                if let Some(asking) = state.asking.get(&agent) {
                    return Start::Waiting(asking.answer.clone());
                }
            }
            let number = state.next;
            state.next += 1;
            let (send, answer) = watch::channel(None);
            state.asking.insert(agent, Asking { number, answer });
            (number, send)
        };
        let answer = send.subscribe();
        // set before the source is called: a source that panics leaves no entry behind
        let finished = Finished {
            inner: Arc::clone(&self.inner),
            agent,
            number,
        };
        let started = (self.inner.sources)(agent).map(|source| {
            let options = ListOptions::new(
                self.inner.work_dir.join(agent.name()),
                self.inner.env.clone(),
            );
            (source.complete, (source.list)(options))
        });
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let listing = match started {
                // nothing to ask, and nothing kept (`server/fleet/models.ts:36`)
                None => ModelListing {
                    agent,
                    models: Vec::new(),
                    complete: false,
                    error: None,
                },
                Some((complete, listed)) => {
                    let listing = match listed.await {
                        Ok(models) if models.is_empty() => ModelListing {
                            agent,
                            models,
                            complete: false,
                            error: Some(format!("{} listed no models", agent.name())),
                        },
                        Ok(models) => ModelListing {
                            agent,
                            models,
                            complete,
                            error: None,
                        },
                        Err(error) => ModelListing {
                            agent,
                            models: Vec::new(),
                            complete: false,
                            error: Some(error),
                        },
                    };
                    let at = inner.clock.now_ms();
                    inner.state().kept.insert(
                        agent,
                        Kept {
                            at,
                            listing: listing.clone(),
                        },
                    );
                    listing
                }
            };
            drop(finished);
            let _ = send.send(Some(listing));
        });
        Start::Waiting(answer)
    }

    /// Every kind's list, in the order of [`FleetAgentKind::ALL`] (`listAll`,
    /// `server/fleet/models.ts:55`).
    pub async fn list_all(&self) -> Vec<ModelListing> {
        let asks: Vec<_> = FleetAgentKind::ALL
            .iter()
            .map(|&agent| self.list(agent, false))
            .collect();
        let mut listings = Vec::with_capacity(asks.len());
        for ask in asks {
            listings.push(ask.await);
        }
        listings
    }

    /// Why `model` will not run on `agent`, when the CLI's list is complete and lacks it; nothing
    /// when it is there, when the CLI gives no complete list, or when it cannot be asked
    /// (`unknown`, `server/fleet/models.ts:66`). A model missing from a kept list is looked up
    /// again first: the CLI may have gained it since. A spawn waits for the CLI only so long
    /// ([`CatalogOptions::spawn_wait`], one deadline for both lookups); past that the model is
    /// let through.
    pub async fn unknown(&self, agent: FleetAgentKind, model: Option<&str>) -> Option<String> {
        let model = model.filter(|model| !model.is_empty())?;
        if !(self.inner.sources)(agent).is_some_and(|source| source.complete) {
            return None;
        }
        let deadline = Instant::now().checked_add(self.inner.spawn_wait);
        for fresh in [false, true] {
            let listing = within(deadline, self.list(agent, fresh)).await?;
            if listing.error.is_some() || model_listed(&listing, model) {
                return None;
            }
        }
        Some(format!(
            "{} does not offer a model named {model}",
            agent.name()
        ))
    }
}

/// What `future` gives by `deadline`; nothing past it. A deadline too far off to reach is none.
async fn within<T>(deadline: Option<Instant>, future: impl Future<Output = T>) -> Option<T> {
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, future).await.ok(),
        None => Some(future.await),
    }
}
