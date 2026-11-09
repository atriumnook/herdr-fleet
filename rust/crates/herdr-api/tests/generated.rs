//! `src/generated.rs` is what the generator makes from `scripts/herdr-schema.json`, and the
//! generator's own rules: names that collide across the schema's sections, and the shapes it
//! cannot map.
//!
//! Regenerate with `HERDR_API_UPDATE=1 cargo test -p herdr-fleet-herdr-api --test generated`.

mod generator;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

fn crate_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn schema_path() -> PathBuf {
    crate_dir().join("../../../scripts/herdr-schema.json")
}

fn generated_path() -> PathBuf {
    crate_dir().join("src/generated.rs")
}

fn read_schema() -> Value {
    serde_json::from_str(&fs::read_to_string(schema_path()).unwrap()).unwrap()
}

/// A folder of its own under Cargo's scratch folder for integration tests, emptied first.
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("herdr-api")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

// scripts/generate-protocol-types.test.ts, "passes when the committed output matches the
// committed schema"
#[test]
fn the_committed_output_matches_the_committed_schema() {
    let update = std::env::var("HERDR_API_UPDATE").as_deref() == Ok("1");
    if let Err(message) = generator::check(&schema_path(), &generated_path(), update) {
        panic!("{message}");
    }
}

// The issue's acceptance: a copy of the schema changed in one place makes the check fail.
#[test]
fn a_schema_changed_in_one_place_makes_the_check_fail() {
    let mut schema = read_schema();
    let source = &mut schema["schemas"]["request"]["$defs"]["ReadSource"]["enum"];
    assert_eq!(source[2], "recent_unwrapped");
    source[2] = json!("recent-unwrapped");
    let dir = scratch("changed-schema");
    let copy = dir.join("herdr-schema.json");
    fs::write(&copy, serde_json::to_string_pretty(&schema).unwrap()).unwrap();
    let before = fs::read_to_string(generated_path()).unwrap();

    let message = generator::check(&copy, &generated_path(), false).unwrap_err();

    assert!(message.to_lowercase().contains("stale"), "{message}");
    // the check only reads: the committed output is left as it was
    assert_eq!(fs::read_to_string(generated_path()).unwrap(), before);
}

// scripts/generate-protocol-types.test.ts, "fails loudly when the generated file has drifted"
#[test]
fn a_drifted_generated_file_makes_the_check_fail() {
    let dir = scratch("drifted-output");
    let copy = dir.join("generated.rs");
    let original = fs::read_to_string(generated_path()).unwrap();
    fs::write(&copy, format!("{original}\npub type DriftSentinel = ();\n")).unwrap();

    let message = generator::check(&schema_path(), &copy, false).unwrap_err();

    assert!(message.to_lowercase().contains("stale"), "{message}");
    assert_eq!(fs::read_to_string(generated_path()).unwrap(), original);
}

fn reversed(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .rev()
                .map(|(key, value)| (key.clone(), reversed(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(reversed).collect()),
        other => other.clone(),
    }
}

// scripts/generate-protocol-types.test.ts, "is deterministic: regenerating produces a
// byte-identical file"; the order of the keys in the schema does not matter either.
#[test]
fn regenerating_produces_a_byte_identical_file() {
    let schema = read_schema();
    let first = generator::generate(&schema);
    assert_eq!(generator::generate(&schema), first);
    assert_eq!(generator::generate(&reversed(&schema)), first);
}

// scripts/generate-protocol-types.test.ts, "spells ReadSource the way the JSON API accepts it"
#[test]
fn read_source_is_spelled_the_way_the_json_api_accepts_it() {
    let source = fs::read_to_string(generated_path()).unwrap();
    assert!(source.contains("recent_unwrapped"));
    assert!(!source.contains("recent-unwrapped"));
}

/// A schema of the herdr shape with the given definitions per section.
fn schema_with(sections: Value) -> Value {
    let mut schemas = serde_json::Map::new();
    for (section, defs) in sections.as_object().unwrap() {
        schemas.insert(section.clone(), json!({ "$defs": defs }));
    }
    json!({ "protocol": 0, "schema_version": 0, "schemas": schemas })
}

fn reference(section: &str, name: &str) -> Value {
    json!({ "$ref": format!("#/schemas/{section}/$defs/{name}") })
}

fn info(section: &str) -> Value {
    json!({
        "type": "object",
        "properties": { "kind": reference(section, "Kind") },
        "required": ["kind"],
    })
}

// scripts/generate-protocol-types.ts: "Colliding names are namespaced only when their structures
// actually differ" (herdr 0.9.0's request ReadSource was "recent-unwrapped", the response's
// "recent_unwrapped").
#[test]
fn a_name_whose_shapes_differ_across_sections_is_prefixed_with_the_section() {
    let schema = schema_with(json!({
        "request": { "Kind": { "type": "string", "enum": ["recent-unwrapped"] } },
        "success_response": { "Kind": { "type": "string", "enum": ["recent_unwrapped"] } },
    }));

    let source = generator::generate(&schema);

    let names = identifiers(&source);
    assert!(names.contains("RequestKind"), "{source}");
    assert!(names.contains("ResponseKind"), "{source}");
    assert!(!names.contains("Kind"), "{source}");
}

/// The Rust identifiers of a source text.
fn identifiers(source: &str) -> std::collections::BTreeSet<&str> {
    source
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .collect()
}

// The same shape in two sections is one type, even though each section's `$ref` names its own
// section; and a type that holds a type whose shapes differ differs as well.
#[test]
fn a_name_whose_shapes_match_across_sections_is_one_type() {
    let same = schema_with(json!({
        "event": { "Info": info("event"), "Kind": { "type": "string", "enum": ["a"] } },
        "success_response": {
            "Info": info("success_response"),
            "Kind": { "type": "string", "enum": ["a"] },
        },
    }));
    let source = generator::generate(&same);
    let names = identifiers(&source);
    assert!(source.contains("pub struct Info {"), "{source}");
    for name in ["EventInfo", "ResponseInfo", "EventKind", "ResponseKind"] {
        assert!(!names.contains(name), "{name}: {source}");
    }
    assert!(names.contains("Kind"), "{source}");

    let different = schema_with(json!({
        "event": { "Info": info("event"), "Kind": { "type": "string", "enum": ["a"] } },
        "success_response": {
            "Info": info("success_response"),
            "Kind": { "type": "string", "enum": ["b"] },
        },
    }));
    let source = generator::generate(&different);
    let names = identifiers(&source);
    for name in ["EventInfo", "ResponseInfo", "EventKind", "ResponseKind"] {
        assert!(names.contains(name), "{name}: {source}");
    }
    assert!(!names.contains("Info"), "{source}");
    assert!(!names.contains("Kind"), "{source}");
}

// The issue's acceptance: a shape the generator cannot map becomes `serde_json::Value`, and the
// generated file lists it.
#[test]
fn a_shape_the_generator_cannot_map_becomes_a_value_and_is_listed() {
    let schema = schema_with(json!({
        "request": {
            "Odd": {
                "type": "object",
                "properties": {
                    "mixed": { "allOf": [{ "type": "string" }, { "minLength": 1 }] },
                    "plain": { "type": "string" },
                },
                "required": ["mixed", "plain"],
            },
            // two tags that would both be the variant `AB`
            "Clash": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": { "type": { "type": "string", "const": "a-b" } },
                        "required": ["type"],
                    },
                    {
                        "type": "object",
                        "properties": { "type": { "type": "string", "const": "a_b" } },
                        "required": ["type"],
                    },
                ],
            },
        },
    }));

    let source = generator::generate(&schema);

    assert!(source.contains("pub mixed: Value,"), "{source}");
    assert!(source.contains("pub plain: String,"), "{source}");
    assert!(source.contains("pub type Clash = Value;"), "{source}");
    let header: String = source
        .lines()
        .take_while(|line| line.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(header.contains("`Odd.mixed`"), "{header}");
    assert!(header.contains("`Clash`"), "{header}");
}

// JSON Schema: `additionalProperties: false` only forbids other properties, so the object is
// still a struct of its properties.
#[test]
fn an_object_that_forbids_other_properties_is_a_struct() {
    let schema = schema_with(json!({
        "request": {
            "Closed": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"],
                "additionalProperties": false,
            },
        },
    }));

    let source = generator::generate(&schema);

    assert!(source.contains("pub struct Closed {"), "{source}");
    assert!(source.contains("pub name: String,"), "{source}");
    // nothing was mapped to `Value`
    assert!(source.contains("//! - none\n"), "{source}");
}

// `self` would be the variant `Self`, which Rust does not allow.
#[test]
fn a_value_named_self_is_a_variant_rust_allows() {
    let schema = schema_with(json!({
        "request": {
            "Who": { "type": "string", "enum": ["self", "other_one"] },
            "Pick": {
                "oneOf": [{
                    "type": "object",
                    "properties": { "type": { "type": "string", "const": "self" } },
                    "required": ["type"],
                }],
            },
        },
    }));

    let source = generator::generate(&schema);

    assert!(!identifiers(&source).contains("Self"), "{source}");
    assert!(source.contains("VSelf = \"self\","), "{source}");
}

// A definition whose name is the struct of another union's shape is not dropped as if it were
// the same type.
#[test]
#[should_panic(expected = "two types are named UA")]
fn a_definition_named_like_the_shape_of_a_union_stops_the_generator() {
    let schema = schema_with(json!({
        "request": {
            "U": {
                "oneOf": [{
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "const": "a" },
                        "x": { "type": "string" },
                    },
                    "required": ["type", "x"],
                }],
            },
            "UA": { "type": "object", "properties": { "y": { "type": "boolean" } } },
        },
    }));

    generator::generate(&schema);
}
