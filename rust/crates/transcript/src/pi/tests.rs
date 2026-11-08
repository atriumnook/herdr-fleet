use std::path::PathBuf;

use super::*;

/// A pi session of the corpus, read in place.
fn corpus_session() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/conversations/pi/readable/readable.jsonl")
}

// TypeScript keeps the indexes in one module variable that `forgetTranscriptState` never clears
// (server/pi-tree.ts `piIndexes`, server/conversation.ts:828-837); each reader here holds its own
// (#203).
#[test]
fn each_reader_keeps_its_own_indexes() {
    let path = corpus_session();
    let size = std::fs::metadata(&path).expect("the corpus session").len();
    let read = Pi::new(Box::new(|_, _| None));
    let other = Pi::new(Box::new(|_, _| None));

    read.segments(&path, size).expect("its branch");

    assert_eq!(read.indexes.len(), 1);
    assert_eq!(other.indexes.len(), 0);
}
