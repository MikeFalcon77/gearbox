# Gearbox Builder
#
# Target names and semantics follow gears-rust's Makefile so the two repos are
# driven the same way. Note the convention that trips people up: `fmt` and
# `clippy` CHECK, while `dev-fmt` and `dev-clippy` FIX. `make dev` is the
# fix-everything entry point.

CARGO ?= cargo

# Minimum tool versions. Pinned because a verdict that disagrees with a
# colleague's is worse than no local check at all.
DENY_MIN_VERSION := 0.20.0
NEXTEST_MIN_VERSION := 0.9.130

# -D clippy::perf is on top of the workspace lint table, matching gears-rust.
CLIPPY_FLAGS := -- -D warnings -D clippy::perf

define check_tool
	@command -v $(1) >/dev/null || (echo "ERROR: $(1) is not installed. Run 'make setup'." && exit 1)
endef

# check_tool_version(tool, minimum). gears-rust delegates this to `cargo gears`;
# done here with sort -V so the check carries no dependency of its own.
define check_tool_version
	@have=$$($(1) --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1); \
	[ -n "$$have" ] || { echo "ERROR: cannot determine $(1) version."; exit 1; }; \
	[ "$$(printf '%s\n%s\n' '$(2)' "$$have" | sort -V | head -1)" = '$(2)' ] \
		|| { echo "ERROR: $(1) $$have is older than $(2). Run 'cargo install --locked $(1)'."; exit 1; }
endef

define check_rustup_component
	@command -v rustup >/dev/null || (echo "ERROR: rustup not installed." && exit 1)
	@rustup component list --installed | grep -q '^$(1)' \
		|| (echo "ERROR: $(1) not installed. Run 'rustup component add $(1)' or 'make setup'." && exit 1)
endef

.PHONY: help setup build fmt fmt-check dev-fmt clippy dev-clippy lint deny test dev-test \
        ts ts-check grammar grammar-check check dev clean

help:
	@echo "build      compile the workspace"
	@echo "fmt        verify formatting            (dev-fmt to apply)"
	@echo "clippy     lint, warnings denied        (dev-clippy to autofix)"
	@echo "lint       compile with warnings denied"
	@echo "deny       advisories, licences, bans, sources"
	@echo "test       run all tests"
	@echo "ts         regenerate the editor client's TypeScript bindings"
	@echo "ts-check   verify those bindings are up to date"
	@echo "grammar    regenerate the editor's .gdl grammar vocabulary"
	@echo "grammar-check  verify that vocabulary is up to date"
	@echo "check      fmt + clippy + lint + deny + test + ts-check + grammar-check"
	@echo "dev        dev-fmt + dev-clippy + test"
	@echo "setup      install the tools the above targets need"

setup:
	rustup component add rustfmt clippy
	$(CARGO) install --locked cargo-nextest
	$(CARGO) install --locked cargo-deny
	@echo "Setup complete."

build:
	$(CARGO) build --workspace --all-targets

# Check formatting. `dev-fmt` applies it.
fmt:
	$(call check_rustup_component,rustfmt)
	$(CARGO) fmt --all --check

# Alias, because `fmt` checking rather than fixing surprises people.
fmt-check: fmt

dev-fmt:
	$(CARGO) fmt --all

# Single pass is enough while the workspace has no Cargo features. Add a
# `cargo hack clippy --each-feature` pass here once it does.
clippy:
	$(call check_rustup_component,clippy)
	$(CARGO) clippy --workspace --all-targets $(CLIPPY_FLAGS)

dev-clippy:
	$(CARGO) clippy --workspace --all-targets --fix --allow-dirty

# Catches warnings clippy does not, e.g. dead code behind a cfg.
lint:
	RUSTFLAGS="-D warnings" $(CARGO) check --workspace --all-targets

deny:
	$(call check_tool,cargo-deny)
	$(call check_tool_version,cargo-deny,$(DENY_MIN_VERSION))
	$(CARGO) deny check

test:
	$(call check_tool,cargo-nextest)
	$(call check_tool_version,cargo-nextest,$(NEXTEST_MIN_VERSION))
	$(CARGO) nextest run --workspace

dev-test: test

# Bindings are generated from the Rust model so the client cannot drift from it
# (cpt-gearbox-nfr-no-type-drift).
ts:
	$(CARGO) test -p gearbox-rpc --test export_bindings

# The anti-drift guard: regenerating must change nothing.
ts-check: ts
	@git diff --exit-code -- ide/gearbox-studio/src/common/generated \
		|| { echo "ERROR: TypeScript bindings are stale. Run 'make ts' and commit the result."; exit 1; }

# The editor's .gdl grammar colours a vocabulary generated from the same globals
# the interpreter evaluates against, so it cannot drift into colouring a
# function the engine does not have (cpt-gearbox-nfr-no-type-drift).
GRAMMAR_OUT := ide/gearbox-studio/src/browser/gdl/generated

grammar:
	$(CARGO) test -p gearbox-gdl --test export_grammar

# The anti-drift guard: regenerating must change nothing.
grammar-check: grammar
	@git diff --exit-code -- $(GRAMMAR_OUT) \
		|| { echo "ERROR: the .gdl grammar vocabulary is stale. Run 'make grammar' and commit the result."; exit 1; }
	@# `git diff` only sees tracked files, so a first-ever generated file would
	@# pass this check while being absent from the commit.
	@[ -z "$$(git ls-files --others --exclude-standard -- $(GRAMMAR_OUT))" ] \
		|| { echo "ERROR: 'make grammar' produced an untracked file. Run 'make grammar' and 'git add' the result."; exit 1; }

# The diagnostics reference is generated from the one catalogue that declares
# the codes, so the documents cannot describe a code the engine does not have
# nor miss one it does (cpt-gearbox-nfr-no-type-drift, applied to the documents'
# view of the catalogue). The curated table in docs/gdl.md stays hand-written:
# it carries a column -- which stage reports the code -- that the catalogue does
# not know.
DIAGNOSTICS_OUT := docs/diagnostics.md

diagnostics:
	$(CARGO) test -p gearbox-ir --test export_diagnostics

# The anti-drift guard: regenerating must change nothing.
diagnostics-check: diagnostics
	@git diff --exit-code -- $(DIAGNOSTICS_OUT) \
		|| { echo "ERROR: the diagnostics reference is stale. Run 'make diagnostics' and commit the result."; exit 1; }
	@# As in grammar-check: `git diff` only sees tracked files, so a first-ever
	@# generated file would pass while being absent from the commit.
	@[ -z "$$(git ls-files --others --exclude-standard -- $(DIAGNOSTICS_OUT))" ] \
		|| { echo "ERROR: 'make diagnostics' produced an untracked file. Run 'make diagnostics' and 'git add' the result."; exit 1; }

check: fmt clippy lint deny test ts-check grammar-check diagnostics-check
	@echo "all checks passed"

dev: dev-fmt dev-clippy test

## oop-run: start the generated host, let it spawn the worker, prove the binding is remote
oop-run:
	@tools/oop-run.sh

clean:
	$(CARGO) clean
