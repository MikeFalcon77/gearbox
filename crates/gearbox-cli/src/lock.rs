//! `gearbox lock` -- questions answered from a written `product.lock`.
//!
//! Separate from `gearbox resolve`, which prints a lock it has just computed.
//! This reads one off disk, and reading is the point: the answers here are the
//! reference side of the verification oracles, so they have to come from the
//! same bytes the generated crate was built from rather than from a fresh
//! resolution that might disagree.
//!
//! `gearbox_lock::read` verifies the recorded hash, so a hand-edited lock fails
//! to load here rather than quietly supplying a wrong reference.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Subcommand, ValueEnum};
use gearbox_ir::{ApplicationId, GearId, ResolvedProduct};

use crate::Format;

/// The default lock path, which is where `gearbox generate` puts it.
const DEFAULT_LOCK: &str = "product.lock";

#[derive(Subcommand)]
pub enum LockQuery {
    /// List the gears composed into one application.
    ///
    /// The reference side of the `--list-registered-gears` oracle: the binary
    /// reports what the linker and `inventory` actually produced, this reports
    /// what the lock said they should.
    Gears {
        /// The lock to read. Defaults to `product.lock` in the working
        /// directory, which is what `gearbox generate` writes.
        #[arg(long, value_name = "FILE")]
        lock: Option<PathBuf>,

        /// Which application.
        #[arg(long, value_name = "ID")]
        application: String,

        #[arg(long, value_enum, default_value_t = Order::Topo)]
        order: Order,

        /// Append a tab and the gear's co-location dependencies, comma
        /// separated and sorted.
        #[arg(long)]
        with_deps: bool,
    },

    /// List the processes the lock resolved to.
    Processes {
        #[arg(long, value_name = "FILE")]
        lock: Option<PathBuf>,

        #[arg(long, value_enum, default_value_t = Format::Text)]
        format: Format,
    },
}

/// How to order the gears of a process.
#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum Order {
    /// Dependency order, as the lock recorded it.
    ///
    /// A caveat that matters for the oracle: the running binary's own order is
    /// *a* topological order but not a canonical one. `GearRegistry` seeds
    /// Kahn's algorithm from `HashMap::keys()`
    /// (`gears-rust/libs/toolkit/src/registry.rs:553`), whose iteration order is
    /// randomized per process, so two runs of one binary legitimately differ
    /// wherever two gears do not depend on each other. Compare against `name`,
    /// not against this.
    Topo,
    /// Sorted by name -- the order to compare a binary's output against.
    Name,
}

/// Answer one lock query.
///
/// # Errors
/// Returns an error when the lock cannot be read or fails its hash check, or
/// when it names no such process.
pub fn run(query: &LockQuery) -> anyhow::Result<ExitCode> {
    match query {
        LockQuery::Gears {
            lock,
            application,
            order,
            with_deps,
        } => gears(lock.as_deref(), application, *order, *with_deps),
        LockQuery::Processes { lock, format } => applications(lock.as_deref(), *format),
    }
}

fn read(path: Option<&Path>) -> anyhow::Result<ResolvedProduct> {
    let path = path.unwrap_or_else(|| Path::new(DEFAULT_LOCK));
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read `{}`: {e}", path.display()))?;
    Ok(gearbox_lock::read(&text)?)
}

fn gears(
    path: Option<&Path>,
    application: &str,
    order: Order,
    with_deps: bool,
) -> anyhow::Result<ExitCode> {
    let lock = read(path)?;
    let id = ApplicationId::new(application)?;
    let Some(resolved) = lock.application(&id) else {
        let known: Vec<&str> = lock.applications.iter().map(|p| p.name.as_str()).collect();
        anyhow::bail!(
            "the lock has no application `{application}`; it has: {}",
            known.join(", ")
        );
    };

    let mut gears: Vec<&GearId> = resolved.gears.iter().collect();
    if order == Order::Name {
        gears.sort();
    }

    for gear in gears {
        if with_deps {
            // Sorted, because the registry's `deps()` is in attribute order and
            // the lock's is a `BTreeSet`. Sorting both sides is what lets the
            // two be compared at all.
            let deps: Vec<&str> = lock
                .gears
                .get(gear)
                .map(|g| g.colocated_deps.iter().map(GearId::as_str).collect())
                .unwrap_or_default();
            println!("{gear}\t{}", deps.join(","));
        } else {
            println!("{gear}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn applications(path: Option<&Path>, format: Format) -> anyhow::Result<ExitCode> {
    let lock = read(path)?;
    match format {
        Format::Json => println!("{}", serde_json::to_string_pretty(&lock.applications)?),
        Format::Text => {
            for application in &lock.applications {
                let gears: Vec<&str> = application.gears.iter().map(GearId::as_str).collect();
                println!(
                    "{}\t{}\tx{}\t{}",
                    application.name,
                    application.bin_name,
                    application.replicas,
                    gears.join(",")
                );
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}
