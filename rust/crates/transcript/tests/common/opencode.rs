//! OpenCode's recorded replies (`api.json`) as the CLI would answer them: `RecordedOpencodeApi` of
//! `scripts/conversation-fixtures.ts`. A stub until #204 writes it: only the opencode cases reach
//! it, and #204 runs them.

use herdr_fleet_transcript::opencode::{OpencodeApi, OpencodeError};
use serde_json::Value;

/// The replies of `opencode api GET <path>` a case recorded, by path with its query arguments
/// sorted by name; a GET of a path not recorded fails the case, naming the path.
pub struct RecordedOpencodeApi;

impl RecordedOpencodeApi {
    /// `api.json` of a case (`{"serviceRunning", "get"}`); an error names what is wrong with it.
    pub fn new(_recorded: &Value, _place: &str) -> Result<Self, String> {
        todo!("#204: OpenCode's recorded replies")
    }

    /// Replaces the replies of these paths from here on (the `api` step).
    pub fn set(&self, _replies: &Value, _place: &str) -> Result<(), String> {
        todo!("#204: OpenCode's recorded replies")
    }

    /// The GETs asked for that the case did not record, kept even when the reader catches the
    /// failure.
    pub fn unrecorded(&self) -> Vec<String> {
        todo!("#204: OpenCode's recorded replies")
    }
}

impl OpencodeApi for RecordedOpencodeApi {
    fn service_running(&self) -> Result<bool, OpencodeError> {
        todo!("#204: OpenCode's recorded replies")
    }

    fn get(&self, _path: &str) -> Result<Value, OpencodeError> {
        todo!("#204: OpenCode's recorded replies")
    }
}
