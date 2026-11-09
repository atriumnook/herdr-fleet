//! TypeScript's absent fields and `null`, kept apart in one way across the protocol types (ADR
//! 0193-protocol-types, and ADR 0244-phase-3-dependencies for the fleet's types):
//!
//! - `field?: T`: `Option<T>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
//!   An absent field reads as `None`, and `None` is left out.
//! - `field: T | null`: `Option<T>` with `#[serde(deserialize_with = "Option::deserialize")]`.
//!   The field is required, and `None` is written as `null`.
//! - `field?: T | null`: `Option<Option<T>>` with `#[serde(default, skip_serializing_if =
//!   "Option::is_none", deserialize_with = "present")]`: `None` absent, `Some(None)` `null`.

use serde::{Deserialize, Deserializer};

/// A field that may be absent (`None`), `null` (`Some(None)`) or a value: called only when the
/// field is present, so a `null` is kept apart from an absent field.
pub(crate) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}
