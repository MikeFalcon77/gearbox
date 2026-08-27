//! The `gearbox` command-line interface.
//!
//! A thin shell over `gearbox-engine`: parse arguments, call the engine, print
//! the result. It holds no product semantics of its own, which is what lets the
//! same engine back the RPC server and the editor without either becoming the
//! authority.
//!
//! One rule shapes the output: **structured output goes to stdout, everything
//! else to stderr.** `gearbox rpc --stdio` will use stdout as its JSON-RPC
//! channel, and a stray progress line there would corrupt the protocol. Getting
//! into that habit now costs nothing and avoids a class of bug later.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{Diagnostic, Severity, SourceId};

#[derive(Parser)]
#[command(
    name = "gearbox",
    about = "Compose, resolve and generate Gears products",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan source roots for `gear.gdl` files and print the catalogue.
    Catalogue {
        /// A source root to scan. Repeatable; each is scanned in order.
        #[arg(long, value_name = "DIR", required = true)]
        root: Vec<PathBuf>,

        /// The id to record for the source. Defaults to the root's directory name.
        #[arg(long, value_name = "ID")]
        source_id: Option<String>,

        #[arg(long, value_enum, default_value_t = Format::Text)]
        format: Format,
    },
}

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
enum Format {
    /// Machine-readable. The stable contract for tooling.
    Json,
    /// Human-readable summary.
    Text,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();
    match cli.command {
        Command::Catalogue {
            root,
            source_id,
            format,
        } => catalogue(&root, source_id.as_deref(), format),
    }
}

fn catalogue(
    roots: &[PathBuf],
    source_id: Option<&str>,
    format: Format,
) -> anyhow::Result<ExitCode> {
    let mut opened = Vec::with_capacity(roots.len());
    for path in roots {
        let id = match source_id {
            Some(id) => SourceId::new(id)?,
            // The directory name is the obvious default and is what a reader
            // would guess; an explicit `--source-id` overrides it.
            None => SourceId::new(default_source_id(path))?,
        };
        opened.push(SourceRoot::open(id, path)?);
    }

    let scan = load_catalogue(&opened);

    match format {
        Format::Json => {
            // stdout: the machine-readable contract.
            println!("{}", serde_json::to_string_pretty(&scan.catalogue)?);
        }
        Format::Text => print_summary(&scan.catalogue, scan.files.len()),
    }

    // Diagnostics always go to stderr, so `| jq` works regardless.
    report(scan.catalogue.diagnostics.as_slice());

    Ok(if scan.catalogue.diagnostics.has_errors() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

/// A source id derived from the root's directory name.
///
/// Falls back to `local` when the path has no usable final component (`/`, or a
/// path ending in `..`), which is rare but should not be a hard error.
fn default_source_id(path: &std::path::Path) -> String {
    path.canonicalize()
        .ok()
        .as_deref()
        .and_then(std::path::Path::file_name)
        .map(|n| n.to_string_lossy().to_lowercase())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "local".to_owned())
}

fn print_summary(catalogue: &gearbox_ir::Catalogue, files: usize) {
    println!(
        "{} gear(s) from {} description file(s), {} contract(s)",
        catalogue.gears.len(),
        files,
        catalogue.contracts.len()
    );

    for gear in catalogue.gears.values() {
        let caps: Vec<&str> = gear.runtime_caps.iter().map(|c| c.as_str()).collect();
        println!("\n  {} [{}]", gear.id, caps.join(", "));
        println!("    {}", gear.gdl_path);
        if !gear.colocated_deps.is_empty() {
            let deps: Vec<&str> = gear
                .colocated_deps
                .iter()
                .map(gearbox_ir::GearId::as_str)
                .collect();
            // Named "co-located with", not "depends on": these edges are
            // link-time and the resolver can never sever them.
            println!("    co-located with: {}", deps.join(", "));
        }
        for provider in &gear.provides {
            let transports: Vec<&str> = provider.transports.iter().map(|t| t.as_str()).collect();
            println!(
                "    provides {} over [{}]",
                provider.contract,
                transports.join(", ")
            );
        }
        for requirement in &gear.consumes {
            if let (Some(contract), Some(from)) =
                (requirement.contract(), requirement.declared_provider())
            {
                println!("    consumes {contract} from {from}");
            }
        }
        for requirement in &gear.requires {
            if let gearbox_ir::RequirementKind::Cluster { primitive, scope } = &requirement.kind {
                let caps: Vec<&str> = requirement
                    .capabilities
                    .iter()
                    .map(gearbox_ir::CapabilityId::as_str)
                    .collect();
                println!(
                    "    requires cluster.{primitive} in `{scope}` [{}]",
                    caps.join(", ")
                );
            }
        }
    }
}

/// Print diagnostics to stderr, most severe first.
fn report(diagnostics: &[Diagnostic]) {
    if diagnostics.is_empty() {
        return;
    }

    let mut sorted: Vec<&Diagnostic> = diagnostics.iter().collect();
    sorted.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.code.cmp(&b.code))
    });

    eprintln!();
    for d in sorted {
        let where_ = d
            .location
            .as_ref()
            .map(|l| format!(" {}:{}", l.uri, l.range.start.line + 1))
            .unwrap_or_default();
        eprintln!("{} [{}]{where_}: {}", label(d.severity), d.code, d.message);
        if let Some(help) = &d.help {
            eprintln!("    help: {help}");
        }
        // The citation is the whole point of a runtime-gap diagnostic: it lets a
        // reader confirm the claim instead of taking the tool's word for it.
        if let Some(evidence) = &d.evidence {
            eprintln!("    evidence: {evidence}");
        }
    }
}

const fn label(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
    }
}
