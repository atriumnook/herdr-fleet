//! herdr の socket API の型を、`scripts/herdr-schema.json` から生成して持つ。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md. How each shape
//! of the schema becomes a Rust type: docs/rust-migration/adr/0245-herdr-api-generation.md.
//!
//! `generated.rs` is written by the generator in `tests/generator/`, never by hand; the macros
//! below are what it expands to.

use serde::Serialize;

/// A method of herdr's socket API: its name on the wire and the type of its params.
///
/// The schema does not say which shape of [`ResponseResult`] a method answers with, so the
/// result is not part of this trait (ADR 0242-phase-3-split, "herdr-api の生成").
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize;
}

/// A string enum of the schema that keeps a value it does not name, as the TypeScript types widen
/// such a union with `(string & {})`: herdr gives no stability guarantee.
macro_rules! open_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $value:literal,)* }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(from = "String", into = "String")]
        pub enum $name {
            $(#[doc = concat!("`\"", $value, "\"`")] $variant,)*
            /// A value this version of the schema does not name, kept as herdr wrote it. A value
            /// the schema names is never put here: make one from a string with `From<String>`,
            /// since `Other("idle")` is not equal to the variant for `"idle"`.
            Other(String),
        }

        impl $name {
            /// The value as herdr writes it.
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $value,)*
                    Self::Other(value) => value,
                }
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                match value.as_str() {
                    $($value => Self::$variant,)*
                    _ => Self::Other(value),
                }
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                match value {
                    $name::Other(value) => value,
                    known => known.as_str().to_owned(),
                }
            }
        }
    };
}

/// A `oneOf` of objects told apart by one property whose value is a constant (`type` in most).
/// A shape with only that property is a unit variant; the others hold a struct of their other
/// fields. A tag the schema does not name is kept whole in `Other`; a tag it names whose fields do
/// not decode is an error.
macro_rules! tagged_union {
    (
        $(#[$meta:meta])* $name:ident, $key:literal,
        unit { $($unit:ident = $unit_tag:literal,)* }
        payload { $($variant:ident($payload:ty) = $tag:literal,)* }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        #[allow(clippy::large_enum_variant)]
        pub enum $name {
            $(#[doc = concat!("`", $key, ": \"", $unit_tag, "\"`")] $unit,)*
            $(#[doc = concat!("`", $key, ": \"", $tag, "\"`")] $variant($payload),)*
            /// A shape this version of the schema does not name, kept as herdr wrote it.
            Other(serde_json::Value),
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                match self {
                    $(Self::$unit => crate::union::write_unit(serializer, $key, $unit_tag),)*
                    $(Self::$variant(payload) => {
                        crate::union::write(serializer, $key, $tag, payload)
                    })*
                    Self::Other(value) => serde::Serialize::serialize(value, serializer),
                }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
                match crate::union::tag::<D::Error>(&value, $key)?.as_str() {
                    $($unit_tag => Ok(Self::$unit),)*
                    $($tag => crate::union::read(value, $tag).map(Self::$variant),)*
                    _ => Ok(Self::Other(value)),
                }
            }
        }
    };
}

/// One marker type per method of the schema, and the list of their names.
macro_rules! methods {
    ($($marker:ident = $name:literal, $params:ident;)*) => {
        /// The name of every method of the schema.
        pub const METHOD_NAMES: &[&str] = &[$($name),*];

        /// One marker type per method of the schema, to name the method in a call:
        /// `methods::PaneRead::NAME` is `"pane.read"`, and its params are
        /// [`PaneReadParams`](super::PaneReadParams).
        pub mod methods {
            $(
                #[doc = concat!("The method `", $name, "`.")]
                #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
                pub struct $marker;

                impl crate::Method for $marker {
                    const NAME: &'static str = $name;
                    type Params = super::$params;
                }
            )*
        }
    };
}

mod generated;
mod union;

pub use generated::*;
