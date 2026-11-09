//! The time the records hold (`startedAt`, `updatedAt`, cooldown ends, outbox times): every one is
//! read from a `Clock`, so the tests can pause tokio's clock and move the records' time with it.
//! Waiting (grace periods, settle checks, retries, `wait`'s limit) uses `tokio::time` instead.
//! ADR 0242-phase-3-split ("非同期と時刻").

use std::time::{SystemTime, UNIX_EPOCH};

/// Where the fleet reads the time from.
pub trait Clock: Send + Sync + 'static {
    /// Milliseconds since the Unix epoch, as JavaScript's `Date.now()`.
    fn now_ms(&self) -> i64;
}

/// The system's clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let since = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the system clock is after 1970");
        i64::try_from(since.as_millis()).expect("milliseconds since 1970 fit an i64")
    }
}

#[cfg(test)]
mod tests {
    use super::{Clock, SystemClock};

    #[test]
    fn reads_the_milliseconds_since_the_epoch() {
        // 2026-11-01T00:00:00Z, worked out by hand: 20,758 days after 1970-01-01 times 86,400,000.
        const NOVEMBER_2026: i64 = 1_793_491_200_000;
        // 2100-01-01T00:00:00Z: 47,482 days after 1970-01-01.
        const YEAR_2100: i64 = 4_102_444_800_000;
        let now = SystemClock.now_ms();
        assert!((NOVEMBER_2026..YEAR_2100).contains(&now), "{now}");
        assert!(SystemClock.now_ms() >= now);
    }
}
