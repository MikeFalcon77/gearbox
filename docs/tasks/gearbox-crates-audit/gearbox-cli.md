# Code Review: gearbox-cli

**Scope:** `crates/gearbox-cli`
**Commit:** `b5a8d7e6c53f`
**Date:** 2026-09-17
**Files:** 4 reviewed, 0 skipped
**Excluded:** trybuild fixtures (`tests/ui/`)
**Agents:** errors, security, async, tests, architecture
**Not run:** toolkit (no ToolKit-owned files in scope); design (disabled with --skip)
**Findings:** 18 reported (3 critical, 11 high, 4 medium); 1 LOW dropped; 0 dropped on a failed anchor check

Automated review. Every finding is a claim to check, not a verdict.

## Findings

### Critical

- **Unvalidated product id from product.gdl is used as an output path segment, so generation can write outside the intended output root.** — `crates/gearbox-cli/src/generate.rs:82` (`RUST-SEC-001`)
  - **Why:** `lock.product.id` is a plain `String` lowered straight from `product(id = ...)` with no validation, and `Path::join` on an absolute or `..`-bearing segment walks right out of `.gearbox/`. An id of `/tmp/x` or `../../../..` makes `gearbox generate` write the whole artefact tree outside the output root. The GDL boundary already refuses `layout` for exactly this reason, so run the id through `ProductId::new` before using it as a path segment.
  - **Fix:** Validate `lock.product.id` with `gearbox_ir::ProductId::new` or `gearbox_ir::is_valid_layout` before joining it into `out_root`, and fail the run when it is not a single kebab-case segment.
- **A gear missing from `lock.gears` is defaulted to an empty dependency list, so an inconsistent lock yields a silently wrong oracle reference with exit code 0.** — `crates/gearbox-cli/src/lock.rs:134` (`RUST-NO-002`)
  - **Why:** If the application lists a gear that `lock.gears` has no entry for, this prints it with an empty dep column and exits 0. Nothing validates that cross-reference on read, `gearbox_lock::read` only checks the hash, and this output is the reference side of the `--list-registered-gears` oracle, so an empty column reads as "this gear has no co-location deps" rather than "the lock is inconsistent". Fail with the gear id instead of defaulting.
  - **Fix:** Replace `.unwrap_or_default()` with an error that names the gear present in the application but absent from `lock.gears`.
- **Source URLs are rendered verbatim, so a credential embedded in a git or registry URL is printed to stdout.** — `crates/gearbox-cli/src/main.rs:945` (`RUST-SEC-001`)
  - **Why:** Both the `Registry` and `Git` arms print `url` verbatim, and a git or alternate-registry URL is a normal place to find `https://user:TOKEN@host/...`. `gearbox product` prints this to stdout via `print_intent`, so under CI the token ends up in the build log. Strip the userinfo component before formatting.
  - **Fix:** Drop the userinfo component from `url` before formatting it in both the `Registry` and `Git` arms of `describe_source`.

### High

- **`generate::run` has no test anywhere in the crate; the non-writable-lock refusal and the dry-run no-write guarantee are unverified.** — `crates/gearbox-cli/src/generate.rs:30` (`RUST-TEST-001`)
  - **Why:** Nothing in this crate tests `run`. The two paths that matter most are the fail-closed gate on line 74, which must refuse to generate from a lock carrying errors, and the `dry_run` branch on line 108, which must write nothing: if either breaks, the result is a tree nobody asked for or an unwanted write, and no test notices. Can we add tests over a temp output root, one with an unwritable lock asserting the bail, one with `dry_run` asserting no file appears under `out_root`?
  - **Fix:** Add a `#[cfg(test)]` module in generate.rs covering the `!lock.is_writable()` bail and a `dry_run` invocation that asserts nothing was written under a temp `out_root`.
- **The resolve pipeline is duplicated between `resolve_product` in main.rs and `generate::run`.** — `crates/gearbox-cli/src/generate.rs:60` (`RUST-ARCH-001`)
  - **Why:** This repeats the whole pipeline `resolve_product` in main.rs already runs: open roots, refuse catalogue errors, canonicalize the product file, load it, default the profile, `resolve_at`, `lock_sources`, `assemble`, down to identical error strings. Two copies of a resolution sequence drift, and they already spell `load_product` through different module paths. Can this move into one helper both `resolve` and `generate` call?
  - **Fix:** Extract the open-roots-through-assemble sequence into a single function returning the resolved lock plus diagnostics, and call it from both `resolve` and `generate`.
- **`lock::run` and its error paths (hash-check failure, unknown application id) have no tests.** — `crates/gearbox-cli/src/lock.rs:85` (`RUST-TEST-001`)
  - **Why:** No test covers `run` or either query under it. The two failures a user actually hits are a lock that fails the hash check inside `read` and an `--application` the lock does not name (line 112), and both are untested, so the nonzero exit on a tampered lock and the `it has: ...` listing can regress silently. This module is documented as the reference side of the verification oracles, which makes a wrong answer here worse than no answer.
  - **Fix:** Add tests calling `gears()` with a lock whose recorded hash does not verify and with an application id the lock does not contain, asserting both return `Err` and that the unknown-id message lists the known applications.
- **Lock read accepts a product whose own recorded diagnostics contain errors, and wraps `LockError` without the actual lock path.** — `crates/gearbox-cli/src/lock.rs:101` (`RUST-NO-002`)
  - **Why:** The hash check only proves the file was not edited, not that the resolution finished: `ResolvedProduct::diagnostics` is serialized into the lock (skipped only when empty), so a lock carrying its own error diagnostics loads cleanly here and every `gearbox lock` answer then comes from a topology the resolver could not finish deciding. `generate` gates on `is_writable()` for exactly this reason. Separately, no path context is added here, so `--lock other.lock` fails with `failed to parse product.lock`, which names the wrong file.
  - **Fix:** After `gearbox_lock::read`, bail when `!product.is_writable()` reporting its diagnostics, and wrap the error with the `path` being read.
- **The ordering contract for `Order::Name` and the `with_deps` dep list, used as the oracle's reference side, is untested and unreachable from a test because the function prints directly.** — `crates/gearbox-cli/src/lock.rs:121` (`RUST-TEST-001`)
  - **Why:** Nothing pins the output ordering for `--order name` or the dep list under `--with-deps`. Drop this `sort()` and the output falls back to the lock's topo order, which the doc on `Order::Topo` says is not canonical, so the comparison against a running binary becomes order-dependent and flaky without failing here. Hard to test as written because `gears()` prints directly: splitting the line construction out into a function that returns the lines would make it testable.
  - **Fix:** Extract gear ordering and dep formatting from `gears()` into a function returning the output lines, and test that `Order::Name` yields name-sorted gears and `with_deps` yields sorted comma-separated deps for a lock with two independent gears.
- **The `--gear` name filter in `list_plugins` is never exercised: both tests pass an empty catalogue, so an inverted comparison still passes.** — `crates/gearbox-cli/src/main.rs:315` (`RUST-TEST-001`)
  - **Why:** Both tests in this crate call `list_plugins` with `Catalogue::default()`, so this filter never executes. `a_named_gear_miss_is_failure` reports a miss because the catalogue is empty, not because a name failed to match, and it keeps passing if the comparison here is inverted. Can we add a catalogue holding one host with an extension point and assert a matching id and a non-matching id separately?
  - **Fix:** Add a test that populates `Catalogue.gears` with a host declaring an extension point and asserts `list_plugins` returns true for the matching id and false for a non-matching one.
- **The plugin vendor-match rule is computed in the CLI as well as in the engine's `check_plugins`, so the two can disagree.** — `crates/gearbox-cli/src/main.rs:341` (`RUST-ARCH-001`)
  - **Why:** This re-implements the vendor match in the CLI instead of asking the engine. `check_plugins` already decides vendor selection, which is where the `linked, but no vendor match` arm below comes from, so `NEEDS vendor override` here can tell an operator the opposite of what the resolver will do once product overrides and profiles are applied. Can `list_plugins` render an outcome the engine computed?
  - **Fix:** Have the engine expose the default-vendor agreement for a host/extension-point pair and render that in `list_plugins` instead of comparing `vendor_selector` against `default_vendor` in the CLI.
- **Canonicalize error swallowed by `unwrap_or_else`, producing a `file:///<relative>` URI that resolves to the wrong path in every plugin diagnostic.** — `crates/gearbox-cli/src/main.rs:386` (`RUST-ERR-001`)
  - **Why:** The canonicalize failure is discarded here, and `file_uri` turns a relative path into `file:///product.gdl`, an absolute-looking URI pointing at the filesystem root. That is the dead-link failure `resolve_product` refuses outright on line 644, so the same mistyped `--product` gives a hard error from one command and a diagnostic pointing at the wrong file from this one.
  - **Fix:** Canonicalize with the error propagated, changing `resolve_plugins` to return `anyhow::Result<ExitCode>`, instead of falling back to the raw path.
- **The `--source-id` with multiple roots refusal, a fix for silent gear replacement, has no test.** — `crates/gearbox-cli/src/main.rs:603` (`RUST-TEST-001`)
  - **Why:** This refusal has no test, and the doc above says what it is holding back: before it, `--source-id x --root a --root b` gave both roots one identity and the second root's gears quietly replaced the first's. The `ensure!` fires before any root is opened, so a test needs no filesystem at all.
  - **Fix:** Add a test calling `open_source_roots` with two root paths and an explicit source id, asserting it returns `Err` before opening anything.
- **`resolve --format toml` emits a non-writable lock as a valid artifact; only the exit code signals the failure.** — `crates/gearbox-cli/src/main.rs:669` (`RUST-NO-002`)
  - **Why:** This prints the lock without checking `resolved.is_writable()`, so a resolution that reported errors still comes out as a well formed lock on stdout. `generate.rs:74` refuses at that point and so does the RPC path in `gearbox-rpc`. `write_canonical` stamps a fresh valid hash, so redirected into a file this output passes `gearbox_lock::read` and `gearbox lock gears` will answer from it.
  - **Fix:** Gate the `Toml` arm on `resolved.is_writable()` and bail with the resolution diagnostics, matching `generate::run`.
- **`refuse_catalogue_errors`, the fail-closed gate shared by resolve and generate, has no test.** — `crates/gearbox-cli/src/main.rs:892` (`RUST-TEST-001`)
  - **Why:** This gate exists because `resolve` and `generate` used to build a lock from a catalogue that had failed to load, and nothing tests it. It is a pure function over a `Catalogue`, so the test is as short as the `list_plugins` tests below: `is_none()` for a clean catalogue, `is_some()` for one with an error diagnostic pushed into `catalogue.diagnostics`.
  - **Fix:** Add tests asserting `refuse_catalogue_errors` is `None` for `Catalogue::default()` and `Some` for a catalogue whose `diagnostics` carry an error-severity `Diagnostic`.

### Medium

- **Canonicalize error stringified into a new `anyhow` error, dropping the source chain, with a message that does not name the actual failure.** — `crates/gearbox-cli/src/generate.rs:47` (`RUST-ERR-001`)
  - **Why:** This flattens the `io::Error` into a string, so the source chain is gone and `{e:#}` in `main` has nothing to unwrap. `anyhow::Context` keeps the cause attached. The wording is also internal vocabulary: the common case is a mistyped or missing `--product`, and "cannot canonicalize" does not say that.
  - **Fix:** Use `.with_context(|| format!("cannot read product description `{}`", product_file.display()))` so the io cause stays in the chain.
- **Template overrides are surfaced only in text output, not in JSON output or as a diagnostic.** — `crates/gearbox-cli/src/generate.rs:124` (`RUST-ARCH-001`)
  - **Why:** `overridden_templates` is reported only in the text arm, so `--format json` never mentions that a template was replaced. Unless the override is also carried in `generated.diagnostics`, a JSON client, which is the CI case, loses a signal the comment above calls something the operator must act on.
  - **Fix:** Emit a warning diagnostic for each overridden template in the engine so both output formats report it, and keep the text line as a summary.
- **list_plugins calls Catalogue::implementations_of inside a nested per-host/per-point loop, and that method scans every gear in the catalogue, so the command is quadratic in catalogue size.** — `crates/gearbox-cli/src/main.rs:325` (`RUST-PERF-001`)
  - **Why:** `implementations_of` walks the whole `catalogue.gears` map and allocates a `Vec` on every call (`gearbox-ir/src/catalogue.rs:766`), and this call sits inside the per-host, per-extension-point loop. So listing costs one full catalogue scan per extension point, quadratic in catalogue size. Grouping gears by `fills.point` in a single pass before the loop makes it linear.
  - **Fix:** Build a map from extension point to implementing gears with one pass over `catalogue.gears` before the host loop, and look each point up in that map instead of calling `implementations_of` per point.
- **Canonicalize error stringified into a new `anyhow` error here as well, losing the io source chain.** — `crates/gearbox-cli/src/main.rs:644` (`RUST-ERR-001`)
  - **Why:** Same stringification as in `generate.rs`: the `io::Error` is interpolated into a fresh `anyhow!`, so the cause is no longer a source and `{e:#}` in `main` cannot expand it. `with_context` keeps it, and the message should say the product description could not be read rather than "cannot canonicalize".
  - **Fix:** Use `.with_context(|| format!("cannot read product description `{}`", product_file.display()))` instead of `map_err` with `anyhow!`.

## Summary

| # | ID | Sev | Location | Issue | Fix |
|---|----|-----|----------|-------|-----|
| 1 | RUST-SEC-001 | CRIT | generate.rs:82 | Unvalidated product id from product.gdl is used as an output path segment, so generation can write outside the intended output root. | Validate `lock.product.id` with `gearbox_ir::ProductId::new` or `gearbox_ir::is_valid_layout` before joining it into `out_root`, and fail the run when it is not a single kebab-case segment. |
| 2 | RUST-NO-002 | CRIT | lock.rs:134 | A gear missing from `lock.gears` is defaulted to an empty dependency list, so an inconsistent lock yields a silently wrong oracle reference with exit code 0. | Replace `.unwrap_or_default()` with an error that names the gear present in the application but absent from `lock.gears`. |
| 3 | RUST-SEC-001 | CRIT | main.rs:945 | Source URLs are rendered verbatim, so a credential embedded in a git or registry URL is printed to stdout. | Drop the userinfo component from `url` before formatting it in both the `Registry` and `Git` arms of `describe_source`. |
| 4 | RUST-TEST-001 | HIGH | generate.rs:30 | `generate::run` has no test anywhere in the crate; the non-writable-lock refusal and the dry-run no-write guarantee are unverified. | Add a `#[cfg(test)]` module in generate.rs covering the `!lock.is_writable()` bail and a `dry_run` invocation that asserts nothing was written under a temp `out_root`. |
| 5 | RUST-ARCH-001 | HIGH | generate.rs:60 | The resolve pipeline is duplicated between `resolve_product` in main.rs and `generate::run`. | Extract the open-roots-through-assemble sequence into a single function returning the resolved lock plus diagnostics, and call it from both `resolve` and `generate`. |
| 6 | RUST-TEST-001 | HIGH | lock.rs:85 | `lock::run` and its error paths (hash-check failure, unknown application id) have no tests. | Add tests calling `gears()` with a lock whose recorded hash does not verify and with an application id the lock does not contain, asserting both return `Err` and that the unknown-id message lists the known applications. |
| 7 | RUST-NO-002 | HIGH | lock.rs:101 | Lock read accepts a product whose own recorded diagnostics contain errors, and wraps `LockError` without the actual lock path. | After `gearbox_lock::read`, bail when `!product.is_writable()` reporting its diagnostics, and wrap the error with the `path` being read. |
| 8 | RUST-TEST-001 | HIGH | lock.rs:121 | The ordering contract for `Order::Name` and the `with_deps` dep list, used as the oracle's reference side, is untested and unreachable from a test because the function prints directly. | Extract gear ordering and dep formatting from `gears()` into a function returning the output lines, and test that `Order::Name` yields name-sorted gears and `with_deps` yields sorted comma-separated deps for a lock with two independent gears. |
| 9 | RUST-TEST-001 | HIGH | main.rs:315 | The `--gear` name filter in `list_plugins` is never exercised: both tests pass an empty catalogue, so an inverted comparison still passes. | Add a test that populates `Catalogue.gears` with a host declaring an extension point and asserts `list_plugins` returns true for the matching id and false for a non-matching one. |
| 10 | RUST-ARCH-001 | HIGH | main.rs:341 | The plugin vendor-match rule is computed in the CLI as well as in the engine's `check_plugins`, so the two can disagree. | Have the engine expose the default-vendor agreement for a host/extension-point pair and render that in `list_plugins` instead of comparing `vendor_selector` against `default_vendor` in the CLI. |
| 11 | RUST-ERR-001 | HIGH | main.rs:386 | Canonicalize error swallowed by `unwrap_or_else`, producing a `file:///<relative>` URI that resolves to the wrong path in every plugin diagnostic. | Canonicalize with the error propagated, changing `resolve_plugins` to return `anyhow::Result<ExitCode>`, instead of falling back to the raw path. |
| 12 | RUST-TEST-001 | HIGH | main.rs:603 | The `--source-id` with multiple roots refusal, a fix for silent gear replacement, has no test. | Add a test calling `open_source_roots` with two root paths and an explicit source id, asserting it returns `Err` before opening anything. |
| 13 | RUST-NO-002 | HIGH | main.rs:669 | `resolve --format toml` emits a non-writable lock as a valid artifact; only the exit code signals the failure. | Gate the `Toml` arm on `resolved.is_writable()` and bail with the resolution diagnostics, matching `generate::run`. |
| 14 | RUST-TEST-001 | HIGH | main.rs:892 | `refuse_catalogue_errors`, the fail-closed gate shared by resolve and generate, has no test. | Add tests asserting `refuse_catalogue_errors` is `None` for `Catalogue::default()` and `Some` for a catalogue whose `diagnostics` carry an error-severity `Diagnostic`. |
| 15 | RUST-ERR-001 | MED | generate.rs:47 | Canonicalize error stringified into a new `anyhow` error, dropping the source chain, with a message that does not name the actual failure. | Use `.with_context(\|\| format!("cannot read product description `{}`", product_file.display()))` so the io cause stays in the chain. |
| 16 | RUST-ARCH-001 | MED | generate.rs:124 | Template overrides are surfaced only in text output, not in JSON output or as a diagnostic. | Emit a warning diagnostic for each overridden template in the engine so both output formats report it, and keep the text line as a summary. |
| 17 | RUST-PERF-001 | MED | main.rs:325 | list_plugins calls Catalogue::implementations_of inside a nested per-host/per-point loop, and that method scans every gear in the catalogue, so the command is quadratic in catalogue size. | Build a map from extension point to implementing gears with one pass over `catalogue.gears` before the host loop, and look each point up in that map instead of calling `implementations_of` per point. |
| 18 | RUST-ERR-001 | MED | main.rs:644 | Canonicalize error stringified into a new `anyhow` error here as well, losing the io source chain. | Use `.with_context(\|\| format!("cannot read product description `{}`", product_file.display()))` instead of `map_err` with `anyhow!`. |

## Raw counts by rule

Before the LOW and anchor filters — an agent that fired on nothing at all is
usually a scope problem, not a clean bill of health.

| ID | Raw |
|----|-----|
| RUST-TEST-001 | 6 |
| RUST-ARCH-001 | 4 |
| RUST-ERR-001 | 3 |
| RUST-NO-002 | 3 |
| RUST-SEC-001 | 2 |
| RUST-PERF-001 | 1 |
