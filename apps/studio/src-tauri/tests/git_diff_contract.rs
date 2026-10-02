//! Inert RPC fixtures exercise the actual native adapter, never a live daemon.
#[path = "../src/commands/error.rs"]
mod error;
#[path = "../src/commands/git.rs"]
mod git;

mod harness {
    use serde_json::Value;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    thread_local! {
        static REPLIES: RefCell<VecDeque<(&'static str, Result<Value, String>)>> = const { RefCell::new(VecDeque::new()) };
    }
    pub fn fixture(replies: Vec<(&'static str, Result<Value, String>)>) {
        REPLIES.with(|queue| *queue.borrow_mut() = replies.into());
    }
    pub fn drained() {
        REPLIES.with(|queue| assert!(queue.borrow().is_empty()));
    }
    pub async fn repo_rpc(method: &str, _repo: &str, _params: Value) -> Result<Value, String> {
        REPLIES.with(|queue| {
            let (expected, reply) = queue.borrow_mut().pop_front().expect("Unexpected RPC");
            assert_eq!(method, expected);
            reply
        })
    }
}

use serde_json::{json, Value};
const HEAD: &str = "git.readBlobAtHead";
const INDEX: &str = "git.readBlobAtIndex";
const WORK: &str = "git.diffContent";
fn present(text: &str) -> Value {
    json!({"success": true, "content": text, "bytes": text.len()})
}
fn missing() -> Value {
    json!({"success": true, "missing": true})
}
async fn diff(staged: bool) -> Result<git::GitDiffContent, error::StudioError> {
    git::git_diff_content("synthetic".into(), "file.txt".into(), staged).await
}

#[tokio::test(flavor = "current_thread")]
async fn staged_new_and_deleted_sides_are_explicitly_missing() {
    for (before, after, expected_before, expected_after) in [
        (missing(), present("new\n"), "", "new\n"),
        (present("old\n"), missing(), "old\n", ""),
    ] {
        harness::fixture(vec![(HEAD, Ok(before)), (INDEX, Ok(after))]);
        let result = diff(true).await.unwrap();
        assert_eq!(result.original, expected_before);
        assert_eq!(result.modified, expected_after);
        harness::drained();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn staged_head_transport_and_git_failures_are_errors() {
    for reply in [
        Err("daemon unavailable".into()),
        Ok(json!({"success": false, "error": "Git failed"})),
    ] {
        harness::fixture(vec![(HEAD, reply)]);
        assert!(diff(true).await.is_err());
        harness::drained();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn staged_index_authorization_failure_is_an_error() {
    harness::fixture(vec![
        (HEAD, Ok(present("committed"))),
        (INDEX, Err("authorization denied".into())),
    ]);
    assert!(diff(true).await.is_err());
    harness::drained();
}
#[tokio::test(flavor = "current_thread")]
async fn oversized_and_malformed_responses_are_not_empty_sides() {
    for payload in [
        json!({"success": true, "tooLarge": true, "bytes": 999999}),
        json!({"success": true}),
        json!({"success": true, "missing": true, "content": "contradiction"}),
        json!({"success": true, "missing": "true", "content": "x", "bytes": 1}),
        json!({"success": true, "content": "short", "bytes": 999}),
        json!({"content": "unknown protocol", "bytes": 16}),
    ] {
        harness::fixture(vec![(HEAD, Ok(payload))]);
        assert!(diff(true).await.is_err());
        harness::drained();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn unstaged_fallback_and_deletion_preserve_expected_content() {
    harness::fixture(vec![
        (INDEX, Ok(missing())),
        (HEAD, Ok(present("old \n"))),
        (WORK, Ok(missing())),
    ]);
    let result = diff(false).await.unwrap();
    assert_eq!(result.original, "old \n");
    assert_eq!(result.modified, "");
    harness::drained();
}
#[tokio::test(flavor = "current_thread")]
async fn unstaged_present_text_preserves_unicode_and_whitespace() {
    harness::fixture(vec![
        (INDEX, Ok(present("€ \n"))),
        (WORK, Ok(present("😀 \n"))),
    ]);
    let result = diff(false).await.unwrap();
    assert_eq!(result.original, "€ \n");
    assert_eq!(result.modified, "😀 \n");
    harness::drained();
}
#[tokio::test(flavor = "current_thread")]
async fn unstaged_worktree_failures_and_size_refusal_propagate() {
    for reply in [
        Err("read permission denied".into()),
        Ok(json!({"success": false, "error": "Git metadata failed"})),
        Ok(json!({"success": true, "tooLarge": true, "bytes": 999999})),
    ] {
        harness::fixture(vec![(INDEX, Ok(present("old"))), (WORK, reply)]);
        assert!(diff(false).await.is_err());
        harness::drained();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn missing_index_does_not_hide_a_failed_head_fallback() {
    harness::fixture(vec![
        (INDEX, Ok(missing())),
        (HEAD, Err("HEAD read failed".into())),
    ]);
    assert!(diff(false).await.is_err());
    harness::drained();
}

#[tokio::test(flavor = "current_thread")]
async fn unstaged_untracked_file_has_only_a_missing_original() {
    harness::fixture(vec![
        (INDEX, Ok(missing())),
        (HEAD, Ok(missing())),
        (WORK, Ok(present("untracked\n"))),
    ]);
    let result = diff(false).await.unwrap();
    assert_eq!(result.original, "");
    assert_eq!(result.modified, "untracked\n");
    harness::drained();
}
