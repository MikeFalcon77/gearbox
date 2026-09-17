# Code Review: gearbox-lock

**Scope:** `crates/gearbox-lock`
**Commit:** `b5a8d7e6c53f`
**Date:** 2026-09-17
**Files:** 11 reviewed, 0 skipped
**Excluded:** trybuild fixtures (`tests/ui/`)
**Agents:** errors, security, async, tests, architecture
**Not run:** toolkit (no ToolKit-owned files in scope); design (disabled with --skip)
**Findings:** 27 reported (0 critical, 14 high, 13 medium); 3 LOW dropped; 0 dropped on a failed anchor check

Automated review. Every finding is a claim to check, not a verdict.

## Findings

### High

- **The provenance dedup in canonicalize_order has no test; all comparisons canonicalize both sides, so its removal is invisible.** — `crates/gearbox-lock/src/canonical.rs:56` (`RUST-TEST-001`)
  - **Why:** Nothing asserts this dedup runs. The fixture builds a duplicate `ColocatedBy` edge for exactly this line, but every test that could notice compares two already-canonicalized products (`write_then_read_round_trips_and_verifies`, `read_returns_canonical_collections`), so if this line went away both sides would keep the duplicate and still compare equal. Can we canonicalize the fixture and assert `provenance.len()` dropped from 4 to 3?
  - **Fix:** Add a test in tests/canonical.rs that calls canonicalize_order on support::fixture() and asserts the duplicate ColocatedBy edge is gone by checking provenance.len().
- **gear.selected_by.sort() is unexercised because every fixture gear has exactly one inclusion reason.** — `crates/gearbox-lock/src/canonical.rs:59` (`RUST-TEST-001`)
  - **Why:** This sort can never be observed by the suite: `resolved_gear` builds every fixture gear with `selected_by: vec![one_reason]`, so a single-element vector is all it ever sorts. Deleting this line would leave every test green, including the golden snapshot, while breaking determinism for that field.
  - **Fix:** Give one fixture gear two InclusionReason entries in a non-sorted order so the determinism and snapshot tests actually depend on this sort.
- **binding.requesters.sort() is unexercised because every fixture cluster binding has exactly one requester.** — `crates/gearbox-lock/src/canonical.rs:62` (`RUST-TEST-001`)
  - **Why:** Both cluster bindings in `support::fixture()` carry a single requester (`requesters: vec![gid("payments-audit")]`), so this sort is a no-op in every test and its removal would go unnoticed. A second requester on the cache binding, listed out of order, would make the ordering observable.
  - **Fix:** Add a second, out-of-order requester to the cache cluster binding in tests/support/mod.rs so the sort has an effect the snapshot and determinism tests can see.
- **The only lock writer emits config values verbatim; credential redaction lives in the generate path, so other callers write plaintext secrets.** — `crates/gearbox-lock/src/canonical.rs:121` (`RUST-SEC-001`)
  - **Why:** This serializes `gears[].config` verbatim, and a literal credential in it is only stripped on the generate path by `secrets::redact_product`. `gearbox resolve --format toml` writes through `write_canonical` directly, so a lock from an older build that still carries a literal password gets printed unredacted. Redaction needs to cover every path that renders a lock, not one of them.
  - **Fix:** Route every lock-rendering path through `secrets::redact_product`, or take a catalogue here and redact inside `write_canonical`, so the writer cannot emit a literal credential.
- **Half of LockDiff's lists are never populated in any test, so a conjunct missing from is_empty() for one of them would report nothing changed.** — `crates/gearbox-lock/src/diff.rs:116` (`RUST-TEST-001`)
  - **Why:** Twelve of the 21 added/removed/changed lists are never non-empty in any test: `sources_added/removed`, `applications_added/removed`, `bindings_added/removed`, `cluster_added/removed`, `cuts_added/changed`, `provenance_added/removed`. The destructure catches a *new* field, not an existing field left out of this boolean chain, and that second shape is the bug `fields_changed`'s own doc comment records happening once already.
  - **Fix:** Add diff tests that populate each currently untested added/removed/changed list and assert !is_empty() plus the expected keys for it.
- **The cuttable summary renderer, including the Some(contract) branch, is never executed by any test.** — `crates/gearbox-lock/src/diff.rs:246` (`RUST-TEST-001`)
  - **Why:** Neither arm of this is ever rendered. The four tests that call `summary()` all pass a diff with an empty cuts list, and the fixture's only `CutCandidate` has `contract: None`, so the `Some` arm is unreachable from the fixture at all and the ` : {contract}` suffix is unverified.
  - **Fix:** Add a diff test that removes or adds a CutCandidate carrying a contract and asserts the rendered summary line, covering both the Some and None suffixes.
- **diff() compares products without canonicalizing them, so ordering differences inside nested collections are reported as content changes.** — `crates/gearbox-lock/src/diff.rs:456` (`RUST-ARCH-001`)
  - **Why:** `diff` never applies `canonicalize_order`, it compares `ResolvedApplication` and `ResolvedGear` values as they arrive. Two products that differ only in the order of `listens`, `spawns`, `selected_by` or `cluster[].requesters` come out as changed, and that is the normal case when one side comes straight from the resolver and the other from `read`, which returns a canonicalized product. `diff_is_order_independent` only passes because every nested list in the fixture has at most one element, so the shuffle helper is a no-op on them.
  - **Fix:** Canonicalize both inputs at the top of `diff` before keying and comparing, or require an already canonicalized product in the signature.
- **by_cut_key collapses CutCandidates sharing (consumer, provider, contract), so changes to a shadowed candidate are dropped from the diff.** — `crates/gearbox-lock/src/diff.rs:531` (`RUST-NO-002`)
  - **Why:** `CutKey` is not a unique key over `cuttable_if_declared`: `canonicalize_order` sorts that vector by exactly `(consumer, provider, contract)` and never dedups it, so two candidates sharing the triple but differing in `blocked_by`, `suggested_edit` or `file` both stay in the lock. Collecting into a `BTreeMap` keyed on the triple keeps only the last, so a change to the shadowed candidate shows up in no list and `is_empty()` still says nothing changed. The invariants the `diff` doc says it assumes do not cover cut candidates.
  - **Fix:** Key cut candidates by the whole CutCandidate, or map each CutKey to the Vec of candidates carrying it, so duplicate keys are compared instead of overwritten.
- **by_provenance_key collapses provenance edges sharing (from, kind, to), so a changed `because` on a shadowed edge is silently absent from the diff.** — `crates/gearbox-lock/src/diff.rs:550` (`RUST-NO-002`)
  - **Why:** `ProvenanceKey` is not unique over `product.provenance`. `canonicalize_order` sorts by `(from, kind, to)` and then calls `dedup()`, which only drops edges equal in *all* fields, so two edges with the same triple and a different `because` both survive into the lock. Collecting into a `BTreeMap` keyed on the triple keeps only the last, so a change to the other edge lands in no list at all and `is_empty()` returns true for a lock that did change.
  - **Fix:** Key provenance by the whole ProvenanceEdge, or map each ProvenanceKey to the Vec of edges carrying it, so duplicate keys are compared instead of overwritten.
- **The LockError::Parse path of the only reader has no test, on either the version probe or the full parse.** — `crates/gearbox-lock/src/read.rs:43` (`RUST-TEST-001`)
  - **Why:** `LockError::Parse` is documented on `read` but no test reaches it. The suite only covers an unsupported version and a hash mismatch, so neither `from_str` call here is tested against a truncated or mangled lock, which is the common corruption case for a generated file people are told not to edit. Can we add a case for malformed TOML and one for valid TOML that misses a required field?
  - **Fix:** Add tests in tests/canonical.rs calling read() with malformed TOML and with valid TOML missing a required ResolvedProduct field, asserting LockError::Parse in both.
- **read() returns a parsed lock with no content validation; layout and spawn bin_name reach path-join and process-spawn sinks unvalidated.** — `crates/gearbox-lock/src/read.rs:61` (`RUST-SEC-001`)
  - **Why:** `read` verifies the hash and then hands back the product without checking any of its content. `product.layout` reaches `out_root.join(input.layout())` in the generator, and the GDL front end already refuses a bad value with `gearbox_ir::is_valid_layout`, so a lock read from disk is the one way into the generator that skips that check. `spawns[].bin_name`, `args` and `working_directory` become a process the host starts, also unchecked here.
  - **Fix:** Validate the parsed product before returning it: run `product.layout` through `gearbox_ir::is_valid_layout` and reject a `spawns[].bin_name` that is not a plain file name.
- **hash_changes_when_content_changes compares full lock texts, so it passes regardless of whether the hash tracks content.** — `crates/gearbox-lock/tests/canonical.rs:63` (`RUST-TEST-001`)
  - **Why:** `hash_a` and `hash_b` hold whole lock documents, not hashes. They differ because `version = "0.2.0"` sits in the body, so this passes even if `compute_hash` returned a constant, which is the one thing the test's name claims to check.
  - **Fix:** Extract product.lock_hash from each written document and assert the two hash values differ, instead of comparing the documents.
- **The shuffle guard checks only 2 of the 8 collections shuffle_orderings claims to reorder, so a partially dead shuffle still passes.** — `crates/gearbox-lock/tests/determinism.rs:46` (`RUST-TEST-001`)
  - **Why:** This guard only inspects `provenance` and `cluster`, and breaks out on the first seed that moves either. `fisher_yates` could stop touching `applications`, `listens`, `spawns`, `bindings`, `cuttable_if_declared` or `diagnostics` and this test would still pass, which is precisely the vacuous-determinism case it exists to rule out.
  - **Fix:** Assert per collection that at least one seed reorders it, covering every collection shuffle_orderings touches, rather than OR-ing two of them and breaking early.
- **summary_lines_are_sorted_and_readable asserts only membership, leaving the documented sort order of summary() untested.** — `crates/gearbox-lock/tests/diff.rs:166` (`RUST-TEST-001`)
  - **Why:** Nothing here checks the sorting the test name promises. Both assertions use `.any()`, so the order `summary()` emits is unpinned, even though `LockDiff`'s doc states every list is sorted and that determinism is the point of `cpt-gearbox-nfr-lock-diff-minimal`.
  - **Fix:** Remove two gears in this test and assert the two `- gear` lines appear in name order, so the sortedness of the category lists is pinned.

### Medium

- **Cut-candidate comparator allocates an owned 3-String key for both operands on every comparison.** — `crates/gearbox-lock/src/canonical.rs:50` (`RUST-PERF-001`)
  - **Why:** This builds two owned keys per comparison, so every `cmp` allocates six Strings and the sort does that O(n log n) times. The bindings sort just above compares borrowed fields directly, and `(&a.consumer, &a.provider, a.contract.as_ref().map_or("", ContractId::as_str))` gives the same ordering here with no allocation.
  - **Fix:** Compare borrowed fields as a tuple, using `map_or("", ContractId::as_str)` for the optional contract, instead of building cloned keys inside the comparator.
- **canonicalize_order dedups provenance only, so duplicate keys in bindings, cluster and cut candidates reach the written lock while diff silently collapses them.** — `crates/gearbox-lock/src/canonical.rs:56` (`RUST-ARCH-001`)
  - **Why:** `provenance` is the only collection deduped here, `bindings`, `cluster` and `cuttable_if_declared` are sorted only. A duplicate `(consumer, contract)` binding therefore gets hashed and written into the lock, while `diff` keys those entries into a `BTreeMap` and keeps one, so the writer and the differ disagree about the content of the same file. The uniqueness `diff` documents as an assumption is not checked anywhere in this crate.
  - **Fix:** Dedup the keyed collections in `canonicalize_order` next to their sorts, or reject a product carrying duplicate keys with a dedicated `LockError` variant.
- **compute_hash clones the whole resolved product to blank a single field, doubling the copy cost on both the write and read paths.** — `crates/gearbox-lock/src/canonical.rs:81` (`RUST-PERF-001`)
  - **Why:** This deep-clones the entire `ResolvedProduct` just to blank one String field, and it happens on every write and every read. `write_canonical` already holds an owned copy whose `lock_hash` it overwrites two lines later, so the hash pass could clear the field in place rather than copying every gear, binding and provenance edge a second time.
  - **Fix:** Add an internal hash helper that takes the already-owned product, clears `product.lock_hash` in place, and hashes it, and have `write_canonical` and `read` use that instead of cloning.
- **Unvalidated lock scalars are interpolated into summary lines, allowing control-character and newline injection into CLI output.** — `crates/gearbox-lock/src/diff.rs:181` (`RUST-SEC-001`)
  - **Why:** `change.before` and `change.after` come straight from a parsed lock and land in a line the CLI and the Studio widget print. Nothing rejects control characters in those scalars, `product.id`, `kubernetes.namespace` and the rest are plain `String` unlike the id newtypes that check for controls, so a lock value holding an escape sequence or a newline can forge or erase lines in the summary someone reads to decide whether a lock change is acceptable.
  - **Fix:** Escape or strip control characters and newlines from lock scalars when rendering them into summary lines.
- **diff_keyed rebuilds two BTreeSets from already-sorted BTreeMap keys and then re-looks-up each shared key to compare values.** — `crates/gearbox-lock/src/diff.rs:429` (`RUST-PERF-001`)
  - **Why:** `before.keys()` is already sorted, so collecting it into a `BTreeSet` re-sorts it and allocates a second index for nothing, twice per call and seven calls per diff. A single merge walk over the two sorted key iterators yields added/removed/changed in one O(n) pass and has both values in hand, which also drops the `before[*k]`/`after[*k]` lookups on line 442.
  - **Fix:** Replace the two BTreeSet collections and the set operations with a single merge walk over `before.iter()` and `after.iter()`, comparing values in place.
- **Application values are deep-cloned into a temporary BTreeMap that exists only for equality comparison.** — `crates/gearbox-lock/src/diff.rs:475` (`RUST-PERF-001`)
  - **Why:** `p.clone()` deep-copies every `ResolvedApplication`, with its gears, listens, spawns and feature sets, into a throwaway map whose values only feed the `!=` in `diff_keyed`. `diff_keyed`'s `V: PartialEq` is satisfied by `&ResolvedApplication`, so the map can hold borrows and copy nothing.
  - **Fix:** Build the map as `BTreeMap<ApplicationId, &ResolvedApplication>` and drop the `p.clone()`.
- **Provenance edge values are deep-cloned into a temporary BTreeMap used only for equality comparison.** — `crates/gearbox-lock/src/diff.rs:547` (`RUST-PERF-001`)
  - **Why:** `e.clone()` copies every provenance edge into a temporary map that is used only for the `!=` inside `diff_keyed`. Provenance is the largest collection in a real lock, and `V: PartialEq` holds for `&ProvenanceEdge`, so the map can borrow the edges instead of duplicating both sides.
  - **Fix:** Build the map as `BTreeMap<ProvenanceKey, &ProvenanceEdge>` and drop the `e.clone()`.
- **HashMismatch asserts a hand edit, but the same variant fires on serialization drift inside an unchanged schema_version.** — `crates/gearbox-lock/src/error.rs:30` (`RUST-ERR-001`)
  - **Why:** This message states a cause that `read` has not established. The hash is recomputed from a re-serialized product, and `ResolvedProductHeader::layout` carries `#[serde(default = "default_layout")]` while `LOCK_SCHEMA_VERSION` is still 1, so a lock written by a build from before `layout` existed parses fine, re-serializes with an extra line, and ends up here being told it was edited by hand.
  - **Fix:** Reword the message to report the mismatch without asserting a hand edit, and include the lock's recorded gearbox_version so a version-drift cause is visible in the error.
- **read() runs two full TOML parses of the same input to extract one field before the real deserialization.** — `crates/gearbox-lock/src/read.rs:43` (`RUST-PERF-001`)
  - **Why:** The whole document is parsed twice here, once for the one-field probe and again in full on line 51. Parsing once into a `toml::Table`, reading `schema_version` off it, then deserializing that value into `ResolvedProduct` keeps the clear version error without a second pass over the file.
  - **Fix:** Parse the input once into a `toml::Table`, check `schema_version` from it, and deserialize `ResolvedProduct` from that parsed value.
- **Hash verification runs over the canonicalized, serde-filtered model, so duplicate entries and unknown keys in the file are invisible to the integrity check.** — `crates/gearbox-lock/src/read.rs:54` (`RUST-SEC-001`)
  - **Why:** The hash is computed after `canonicalize_order`, which sorts and dedups, so an edit that canonicalization erases still verifies. Duplicating a provenance edge or a diagnostic in the file passes this check, and so does any unknown TOML key, since nothing sets `deny_unknown_fields` on the lock types. `LockError::HashMismatch` promises a hand edit is caught, and for that class of edit it is not.
  - **Fix:** Reject a parsed lock that carries duplicate provenance edges or diagnostics before hashing, and add `#[serde(deny_unknown_fields)]` to the lock types so ignored keys cannot ride in a lock that reports as verified.
- **read() can return the write-side LockError::Serialize variant, which its # Errors doc omits and whose message describes the wrong operation.** — `crates/gearbox-lock/src/read.rs:55` (`RUST-ERR-001`)
  - **Why:** A failure here surfaces as `LockError::Serialize`, whose message is "failed to serialize product.lock". That reads backwards on a read path, and `read`'s `# Errors` section lists only `UnsupportedSchemaVersion`, `Parse` and `HashMismatch`, so a caller matching on what this function documents will not handle it.
  - **Fix:** Add a read-side variant for a failed hash recomputation, or list LockError::Serialize in read's # Errors section and reword its message so it fits both directions.
- **The length assertion compares two unmodified fixture() clones, so it is true by construction.** — `crates/gearbox-lock/tests/diff.rs:276` (`TEST-QUALITY-2`)
  - **Why:** `after` is still an untouched `support::fixture()` on this line, so this compares the fixture's diagnostics count with itself and can never fail. The precondition the test actually needs is already guaranteed by the `map` below, which preserves length by construction.
  - **Fix:** Drop this assertion and instead assert the observed counts in diagnostics_changed are equal to each other and to the fixture's diagnostics length.
- **The full-text snapshot is the sole coverage for ordering and dedup guarantees and hides which guarantee broke; the embedded hash makes it churn on every fixture edit.** — `crates/gearbox-lock/tests/snapshot.rs:16` (`TEST-QUALITY-8`)
  - **Why:** This golden file is currently the only coverage for canonical ordering and provenance dedup, and it covers them opaquely: a reviewer sees a whole-document text diff, not which ordering rule moved. It also embeds `lock_hash`, so any fixture edit churns the snapshot, and an accidental ordering change gets re-accepted along with the intended one when someone runs `cargo insta accept`.
  - **Fix:** Keep the snapshot but add named assertions in tests/canonical.rs for each documented ordering and for the provenance dedup, so a rule change fails a specific test rather than only moving the golden file.

## Summary

| # | ID | Sev | Location | Issue | Fix |
|---|----|-----|----------|-------|-----|
| 1 | RUST-TEST-001 | HIGH | canonical.rs:56 | The provenance dedup in canonicalize_order has no test; all comparisons canonicalize both sides, so its removal is invisible. | Add a test in tests/canonical.rs that calls canonicalize_order on support::fixture() and asserts the duplicate ColocatedBy edge is gone by checking provenance.len(). |
| 2 | RUST-TEST-001 | HIGH | canonical.rs:59 | gear.selected_by.sort() is unexercised because every fixture gear has exactly one inclusion reason. | Give one fixture gear two InclusionReason entries in a non-sorted order so the determinism and snapshot tests actually depend on this sort. |
| 3 | RUST-TEST-001 | HIGH | canonical.rs:62 | binding.requesters.sort() is unexercised because every fixture cluster binding has exactly one requester. | Add a second, out-of-order requester to the cache cluster binding in tests/support/mod.rs so the sort has an effect the snapshot and determinism tests can see. |
| 4 | RUST-SEC-001 | HIGH | canonical.rs:121 | The only lock writer emits config values verbatim; credential redaction lives in the generate path, so other callers write plaintext secrets. | Route every lock-rendering path through `secrets::redact_product`, or take a catalogue here and redact inside `write_canonical`, so the writer cannot emit a literal credential. |
| 5 | RUST-TEST-001 | HIGH | diff.rs:116 | Half of LockDiff's lists are never populated in any test, so a conjunct missing from is_empty() for one of them would report nothing changed. | Add diff tests that populate each currently untested added/removed/changed list and assert !is_empty() plus the expected keys for it. |
| 6 | RUST-TEST-001 | HIGH | diff.rs:246 | The cuttable summary renderer, including the Some(contract) branch, is never executed by any test. | Add a diff test that removes or adds a CutCandidate carrying a contract and asserts the rendered summary line, covering both the Some and None suffixes. |
| 7 | RUST-ARCH-001 | HIGH | diff.rs:456 | diff() compares products without canonicalizing them, so ordering differences inside nested collections are reported as content changes. | Canonicalize both inputs at the top of `diff` before keying and comparing, or require an already canonicalized product in the signature. |
| 8 | RUST-NO-002 | HIGH | diff.rs:531 | by_cut_key collapses CutCandidates sharing (consumer, provider, contract), so changes to a shadowed candidate are dropped from the diff. | Key cut candidates by the whole CutCandidate, or map each CutKey to the Vec of candidates carrying it, so duplicate keys are compared instead of overwritten. |
| 9 | RUST-NO-002 | HIGH | diff.rs:550 | by_provenance_key collapses provenance edges sharing (from, kind, to), so a changed `because` on a shadowed edge is silently absent from the diff. | Key provenance by the whole ProvenanceEdge, or map each ProvenanceKey to the Vec of edges carrying it, so duplicate keys are compared instead of overwritten. |
| 10 | RUST-TEST-001 | HIGH | read.rs:43 | The LockError::Parse path of the only reader has no test, on either the version probe or the full parse. | Add tests in tests/canonical.rs calling read() with malformed TOML and with valid TOML missing a required ResolvedProduct field, asserting LockError::Parse in both. |
| 11 | RUST-SEC-001 | HIGH | read.rs:61 | read() returns a parsed lock with no content validation; layout and spawn bin_name reach path-join and process-spawn sinks unvalidated. | Validate the parsed product before returning it: run `product.layout` through `gearbox_ir::is_valid_layout` and reject a `spawns[].bin_name` that is not a plain file name. |
| 12 | RUST-TEST-001 | HIGH | canonical.rs:63 | hash_changes_when_content_changes compares full lock texts, so it passes regardless of whether the hash tracks content. | Extract product.lock_hash from each written document and assert the two hash values differ, instead of comparing the documents. |
| 13 | RUST-TEST-001 | HIGH | determinism.rs:46 | The shuffle guard checks only 2 of the 8 collections shuffle_orderings claims to reorder, so a partially dead shuffle still passes. | Assert per collection that at least one seed reorders it, covering every collection shuffle_orderings touches, rather than OR-ing two of them and breaking early. |
| 14 | RUST-TEST-001 | HIGH | diff.rs:166 | summary_lines_are_sorted_and_readable asserts only membership, leaving the documented sort order of summary() untested. | Remove two gears in this test and assert the two `- gear` lines appear in name order, so the sortedness of the category lists is pinned. |
| 15 | RUST-PERF-001 | MED | canonical.rs:50 | Cut-candidate comparator allocates an owned 3-String key for both operands on every comparison. | Compare borrowed fields as a tuple, using `map_or("", ContractId::as_str)` for the optional contract, instead of building cloned keys inside the comparator. |
| 16 | RUST-ARCH-001 | MED | canonical.rs:56 | canonicalize_order dedups provenance only, so duplicate keys in bindings, cluster and cut candidates reach the written lock while diff silently collapses them. | Dedup the keyed collections in `canonicalize_order` next to their sorts, or reject a product carrying duplicate keys with a dedicated `LockError` variant. |
| 17 | RUST-PERF-001 | MED | canonical.rs:81 | compute_hash clones the whole resolved product to blank a single field, doubling the copy cost on both the write and read paths. | Add an internal hash helper that takes the already-owned product, clears `product.lock_hash` in place, and hashes it, and have `write_canonical` and `read` use that instead of cloning. |
| 18 | RUST-SEC-001 | MED | diff.rs:181 | Unvalidated lock scalars are interpolated into summary lines, allowing control-character and newline injection into CLI output. | Escape or strip control characters and newlines from lock scalars when rendering them into summary lines. |
| 19 | RUST-PERF-001 | MED | diff.rs:429 | diff_keyed rebuilds two BTreeSets from already-sorted BTreeMap keys and then re-looks-up each shared key to compare values. | Replace the two BTreeSet collections and the set operations with a single merge walk over `before.iter()` and `after.iter()`, comparing values in place. |
| 20 | RUST-PERF-001 | MED | diff.rs:475 | Application values are deep-cloned into a temporary BTreeMap that exists only for equality comparison. | Build the map as `BTreeMap<ApplicationId, &ResolvedApplication>` and drop the `p.clone()`. |
| 21 | RUST-PERF-001 | MED | diff.rs:547 | Provenance edge values are deep-cloned into a temporary BTreeMap used only for equality comparison. | Build the map as `BTreeMap<ProvenanceKey, &ProvenanceEdge>` and drop the `e.clone()`. |
| 22 | RUST-ERR-001 | MED | error.rs:30 | HashMismatch asserts a hand edit, but the same variant fires on serialization drift inside an unchanged schema_version. | Reword the message to report the mismatch without asserting a hand edit, and include the lock's recorded gearbox_version so a version-drift cause is visible in the error. |
| 23 | RUST-PERF-001 | MED | read.rs:43 | read() runs two full TOML parses of the same input to extract one field before the real deserialization. | Parse the input once into a `toml::Table`, check `schema_version` from it, and deserialize `ResolvedProduct` from that parsed value. |
| 24 | RUST-SEC-001 | MED | read.rs:54 | Hash verification runs over the canonicalized, serde-filtered model, so duplicate entries and unknown keys in the file are invisible to the integrity check. | Reject a parsed lock that carries duplicate provenance edges or diagnostics before hashing, and add `#[serde(deny_unknown_fields)]` to the lock types so ignored keys cannot ride in a lock that reports as verified. |
| 25 | RUST-ERR-001 | MED | read.rs:55 | read() can return the write-side LockError::Serialize variant, which its # Errors doc omits and whose message describes the wrong operation. | Add a read-side variant for a failed hash recomputation, or list LockError::Serialize in read's # Errors section and reword its message so it fits both directions. |
| 26 | TEST-QUALITY-2 | MED | diff.rs:276 | The length assertion compares two unmodified fixture() clones, so it is true by construction. | Drop this assertion and instead assert the observed counts in diagnostics_changed are equal to each other and to the fixture's diagnostics length. |
| 27 | TEST-QUALITY-8 | MED | snapshot.rs:16 | The full-text snapshot is the sole coverage for ordering and dedup guarantees and hides which guarantee broke; the embedded hash makes it churn on every fixture edit. | Keep the snapshot but add named assertions in tests/canonical.rs for each documented ordering and for the provenance dedup, so a rule change fails a specific test rather than only moving the golden file. |

## Raw counts by rule

Before the LOW and anchor filters — an agent that fired on nothing at all is
usually a scope problem, not a clean bill of health.

| ID | Raw |
|----|-----|
| RUST-TEST-001 | 9 |
| RUST-PERF-001 | 6 |
| RUST-SEC-001 | 5 |
| RUST-ARCH-001 | 2 |
| RUST-ERR-001 | 2 |
| RUST-NO-002 | 2 |
| TEST-QUALITY-5 | 2 |
| TEST-QUALITY-2 | 1 |
| TEST-QUALITY-8 | 1 |
