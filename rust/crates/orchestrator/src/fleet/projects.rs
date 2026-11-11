//! Projects: one coordinator per repository, in its main checkout; `startProject` and the
//! coordinator's lookup of `server/fleet/orchestrator.ts`. #262 fills it.

/// What the projects keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

// stub: #262
