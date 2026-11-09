//! The error of every call to herdr (`HerdrError` in `server/herdr/client.ts`).

use std::fmt;

/// Why a call to herdr failed. [`code`](Self::code) is the code TypeScript gives the same
/// failure, and the message its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HerdrError {
    /// No answer within the time limit (`timeout`).
    Timeout(String),
    /// herdr sent a line that is not JSON, or an answer of another shape than expected
    /// (`bad_frame`).
    BadFrame(String),
    /// The socket failed after it was opened (`socket_error`).
    SocketError(String),
    /// herdr closed the connection before it answered (`closed`).
    Closed(String),
    /// The socket could not be opened (`connect_failed`).
    ConnectFailed(String),
    /// herdr answered with an error: its own code (`pane_not_found`, `agent_blocked`, …).
    Herdr { code: String, message: String },
}

impl HerdrError {
    /// The code, as TypeScript's `HerdrError.code` has it.
    pub fn code(&self) -> &str {
        match self {
            Self::Timeout(_) => "timeout",
            Self::BadFrame(_) => "bad_frame",
            Self::SocketError(_) => "socket_error",
            Self::Closed(_) => "closed",
            Self::ConnectFailed(_) => "connect_failed",
            Self::Herdr { code, .. } => code,
        }
    }

    /// The message, as TypeScript's `HerdrError.message` has it.
    pub fn message(&self) -> &str {
        match self {
            Self::Timeout(message)
            | Self::BadFrame(message)
            | Self::SocketError(message)
            | Self::Closed(message)
            | Self::ConnectFailed(message)
            | Self::Herdr { message, .. } => message,
        }
    }

    /// herdr's own error frame (`{"error": {"code", "message"}}`), with TypeScript's defaults
    /// for a missing code or message.
    pub(crate) fn from_frame(error: &serde_json::Value, default_message: &str) -> Self {
        let text = |key: &str| error.get(key).and_then(serde_json::Value::as_str);
        Self::Herdr {
            code: text("code").unwrap_or("herdr_error").to_owned(),
            message: text("message").unwrap_or(default_message).to_owned(),
        }
    }
}

impl fmt::Display for HerdrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for HerdrError {}
