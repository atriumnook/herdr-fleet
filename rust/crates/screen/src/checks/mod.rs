//! The agent adapters' looks at their CLIs' screens, and Cursor's usage screen. #200 reads them;
//! until then they are stubs.

use protocol::{FleetAgentKind, UsageReading};

use crate::ScreenChecks;

/// The looks of the adapter of `kind`.
pub(crate) fn for_kind(_kind: FleetAgentKind) -> ScreenChecks {
    todo!("#200 reads the adapters' screens")
}

/// `cursorUsage`.
pub(crate) fn cursor_usage(_screen: &str, _now: i64) -> Option<UsageReading> {
    todo!("#200 reads Cursor's usage screen")
}
