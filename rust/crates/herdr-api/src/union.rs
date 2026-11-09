//! Reading and writing the tagged unions of `generated.rs` (the `tagged_union!` macro).

use serde::de::DeserializeOwned;
use serde::ser::Error as _;
use serde::{Serialize, Serializer, de};
use serde_json::{Map, Value};

/// The tag of an object: the string value of its property `key`.
pub(crate) fn tag<E: de::Error>(value: &Value, key: &'static str) -> Result<String, E> {
    let Value::Object(object) = value else {
        return Err(E::custom(format!("expected an object with a `{key}`")));
    };
    match object.get(key) {
        Some(Value::String(tag)) => Ok(tag.clone()),
        Some(_) => Err(E::custom(format!("`{key}` is not a string"))),
        None => Err(E::missing_field(key)),
    }
}

/// The fields of a shape the tag names; the tag itself is left to the struct to ignore.
pub(crate) fn read<T: DeserializeOwned, E: de::Error>(value: Value) -> Result<T, E> {
    serde_json::from_value(value).map_err(E::custom)
}

pub(crate) fn write_unit<S: Serializer>(
    serializer: S,
    key: &str,
    tag: &str,
) -> Result<S::Ok, S::Error> {
    tagged(key, tag, Map::new()).serialize(serializer)
}

pub(crate) fn write<S: Serializer, T: Serialize>(
    serializer: S,
    key: &str,
    tag: &str,
    payload: &T,
) -> Result<S::Ok, S::Error> {
    match serde_json::to_value(payload).map_err(S::Error::custom)? {
        Value::Object(fields) => tagged(key, tag, fields).serialize(serializer),
        _ => Err(S::Error::custom(
            "the fields of a tagged shape are not an object",
        )),
    }
}

/// The tag first, then the fields, as herdr writes them.
fn tagged(key: &str, tag: &str, fields: Map<String, Value>) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert(key.to_owned(), Value::String(tag.to_owned()));
    object.extend(fields);
    object
}
