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
use gearbox_engine::{SourceRoot, check_plugins, load_catalogue, load_product};
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

    /// Serve JSON-RPC over stdio, for the Studio and the `.gdl` language client.
    ///
    /// **Nothing but JSON-RPC goes to stdout while this runs.** Logs go to
    /// stderr and to `gearbox/log` notifications.
    Rpc {
        /// Required for symmetry with LSP servers, which are all started this
        /// way; there is no other transport, so it carries no choice.
        #[arg(long)]
        stdio: bool,

        /// A source root to scan, used when `initialize` names none. Repeatable.
        #[arg(long, value_name = "DIR")]
        root: Vec<PathBuf>,
    },

    /// Show plugin extension points and the implementations available for them.
    ///
    /// Without `--product`, lists what a gear *could* use. With `--product`,
    /// resolves what it *will* use, per deployment profile -- which is a
    /// different question, because the choice is profile-scoped.
    Plugins {
        /// A source root to scan. Repeatable.
        #[arg(long, value_name = "DIR", required = true)]
        root: Vec<PathBuf>,

        /// Limit to one host gear.
        #[arg(long, value_name = "ID")]
        gear: Option<String>,

        /// Resolve against a product description instead of listing.
        #[arg(long, value_name = "FILE")]
        product: Option<PathBuf>,
    },

    /// Evaluate a `product.gdl` and print the operator intent it declares.
    ///
    /// Evaluation only: no catalogue is read, so this reports what the file says
    /// and whether it is internally consistent, not whether the gears it names
    /// exist. That is `gearbox resolve`'s question.
    Product {
        /// Path to the product description.
        #[arg(long, value_name = "FILE")]
        file: PathBuf,

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
        Command::Product { file, format } => product(&file, format),
        Command::Rpc { stdio, root } => {
            if !stdio {
                anyhow::bail!("only `--stdio` is supported");
            }
            gearbox_rpc::serve_stdio(&root)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Plugins {
            root,
            gear,
            product,
        } => plugins(&root, gear.as_deref(), product.as_deref()),
    }
}

fn plugins(
    roots: &[PathBuf],
    gear: Option<&str>,
    product_file: Option<&std::path::Path>,
) -> anyhow::Result<ExitCode> {
    let mut opened = Vec::with_capacity(roots.len());
    for path in roots {
        opened.push(SourceRoot::open(
            SourceId::new(default_source_id(path))?,
            path,
        )?);
    }
    let catalogue = load_catalogue(&opened).catalogue;

    if let Some(file) = product_file {
        return Ok(resolve_plugins(&catalogue, file));
    }
    list_plugins(&catalogue, gear);
    Ok(ExitCode::SUCCESS)
}

/// What each host *could* use. The answer to "which implementations exist".
fn list_plugins(catalogue: &gearbox_ir::Catalogue, only: Option<&str>) {
    let mut any = false;
    for host in catalogue.gears.values() {
        if host.extension_points.is_empty() {
            continue;
        }
        if only.is_some_and(|id| host.id.as_str() != id) {
            continue;
        }
        any = true;

        let selector = host.vendor_selector.as_deref().unwrap_or("<none>");
        println!("\n{}   selector: vendor = \"{selector}\"", host.id);

        for point in &host.extension_points {
            println!("\n  extension point  {}", point.qualified());
            let impls = catalogue.implementations_of(point);
            if impls.is_empty() {
                println!("    (no implementation in the catalogue)");
                continue;
            }
            for gear in impls {
                let fill = gear.fills.as_ref();
                let vendor = fill
                    .and_then(|f| f.default_vendor.as_deref())
                    .unwrap_or("<none>");
                let priority = fill
                    .and_then(|f| f.default_priority)
                    .map_or_else(|| "-".to_owned(), |p| p.to_string());
                // Whether the compiled-in defaults already agree. A mismatch is
                // not fatal -- the product can set `vendor` on either side --
                // but it is what silently fails if nobody does.
                let mark = if host.vendor_selector.as_deref()
                    == fill.and_then(|f| f.default_vendor.as_deref())
                {
                    "matches"
                } else {
                    "NEEDS vendor override"
                };
                println!(
                    "    {:<26} vendor={vendor:<20} priority={priority:<6} {mark}",
                    gear.id
                );
                println!("      {} · {}", gear.package.crate_name, gear.gdl_path);
            }
        }
    }

    if !any {
        println!("no gear declares a plugin extension point");
        println!("(a host declares `sdk = cargo(...)`; the points are read from that crate)");
    }
}

/// What each host *will* use, per profile.
fn resolve_plugins(catalogue: &gearbox_ir::Catalogue, file: &std::path::Path) -> ExitCode {
    let scan = load_product(file, None);
    let Some(intent) = scan.intent else {
        report(scan.diagnostics.as_slice());
        return ExitCode::FAILURE;
    };

    let mut diagnostics = gearbox_ir::Diagnostics::new();
    let uri = format!("file://{}", file.display());
    let resolutions = check_plugins(catalogue, &intent, &uri, &mut diagnostics);
    diagnostics.finish();

    let mut last: Option<(String, String)> = None;
    for r in &resolutions {
        let key = (r.host.to_string(), r.point.qualified());
        if last.as_ref() != Some(&key) {
            println!("\n{} / {}", key.0, key.1);
            last = Some(key);
        }
        let outcome = match (&r.winner, r.tied, r.linked.len()) {
            (Some(w), _, 1) => w.to_string(),
            (Some(w), _, n) => format!("{w}  (wins over {} other linked)", n - 1),
            (None, true, n) => format!("undefined - {n} tied on priority"),
            (None, _, 0) => "- nothing selected".to_owned(),
            (None, _, _) => "- linked, but no vendor match".to_owned(),
        };
        println!("  {:<8} -> {outcome}", r.profile.as_str());
    }

    if resolutions.is_empty() {
        println!("no selected gear declares a plugin extension point");
    }

    report(diagnostics.as_slice());
    if diagnostics.has_errors() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn product(file: &std::path::Path, format: Format) -> anyhow::Result<ExitCode> {
    let scan = load_product(file, None);

    if let Some(intent) = &scan.intent {
        match format {
            Format::Json => println!("{}", serde_json::to_string_pretty(intent)?),
            Format::Text => print_intent(intent),
        }
    }

    report(scan.diagnostics.as_slice());

    Ok(if scan.diagnostics.has_errors() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn print_intent(intent: &gearbox_ir::ProductIntent) {
    println!(
        "{} {} ({}), default profile `{}`",
        intent.id, intent.version, intent.display_name, intent.default_profile
    );

    println!("\n  sources");
    for (id, source) in &intent.sources {
        let pinned = if source.is_immutable() {
            ""
        } else {
            "  [not immutable: repeatable, not reproducible]"
        };
        println!("    {id}: {}{pinned}", describe_source(source));
    }

    println!("\n  profiles");
    for (id, profile) in &intent.profiles {
        let default = if *id == intent.default_profile {
            " (default)"
        } else {
            ""
        };
        println!("    {id}: {}{default}", profile.kind());
    }

    println!("\n  gears");
    for selection in &intent.selected_gears {
        println!("    {} from {}", selection.gear, selection.source);
        // Which extension point each fills is a catalogue fact, so it is not
        // shown here: this command evaluates the product alone. `gearbox
        // plugins --product` resolves them against the catalogue.
        for plugin in &selection.plugins {
            let scope = if plugin.profiles.is_empty() {
                "all profiles".to_owned()
            } else {
                plugin
                    .profiles
                    .iter()
                    .map(gearbox_ir::ProfileId::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            println!("      plugin {} [{scope}]", plugin.gear);
        }
    }

    // Profile-scoped declarations are printed per profile, because that is the
    // only way to see what a given `--profile` will actually resolve.
    for id in intent.profiles.keys() {
        let bindings = intent.bindings_for(id);
        let scopes = intent.cluster_scopes_for(id);
        let pins = intent.process_pins_for(id);
        if bindings.is_empty() && scopes.is_empty() && pins.is_empty() {
            continue;
        }
        println!("\n  profile `{id}`");
        for binding in bindings {
            let transport = binding
                .transport
                .map(|t| format!(" over {t}"))
                .unwrap_or_default();
            println!(
                "    bind {} -> {} as {}{transport}",
                binding.consumer,
                binding.contract,
                describe_mode(binding.mode)
            );
        }
        for scope in scopes {
            println!(
                "    cluster `{}` cache = {}{}",
                scope.scope,
                scope.cache.provider,
                if scope.cache.options.is_empty() {
                    String::new()
                } else {
                    format!(" ({} option(s))", scope.cache.options.len())
                }
            );
        }
        for pin in pins {
            println!(
                "    process `{}` anchored on {} x{}",
                pin.name, pin.anchor, pin.replicas
            );
        }
    }

    if !intent.preferences.is_empty() {
        println!("\n  preferences");
        for preference in &intent.preferences {
            println!("    {}", describe_preference(preference));
        }
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
        Format::Text => print_summary(&scan),
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

fn print_summary(scan: &gearbox_engine::CatalogueScan) {
    let catalogue = &scan.catalogue;
    println!(
        "{} gear(s) from {} description file(s), {} contract(s)",
        catalogue.gears.len(),
        scan.files.len(),
        catalogue.contracts.len()
    );
    // What the load actually cost. Worth showing because it is the number the
    // incremental-loading work is about: crates parsed is the expensive stage,
    // and the gap against requests is the sharing a single load already gets.
    println!(
        "  parsed {} crate(s) for {} request(s)",
        scan.crates_scanned, scan.scan_requests
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

/// Describe a source for a human.
///
/// Spelled out here rather than as a `Display` impl on the IR type: this is one
/// presentation, and the IR should not own a phrasing only the CLI uses.
fn describe_source(source: &gearbox_ir::SourceDecl) -> String {
    match source {
        gearbox_ir::SourceDecl::Path { at } => format!("path {at}"),
        gearbox_ir::SourceDecl::Git {
            url,
            tag,
            rev,
            branch,
        } => {
            let pin = tag
                .as_ref()
                .map(|t| format!("tag {t}"))
                .or_else(|| rev.as_ref().map(|r| format!("rev {r}")))
                .or_else(|| branch.as_ref().map(|b| format!("branch {b}")))
                .unwrap_or_else(|| "unpinned".to_owned());
            format!("git {url} @ {pin}")
        }
    }
}

fn describe_mode(mode: gearbox_ir::BindingMode) -> &'static str {
    match mode {
        gearbox_ir::BindingMode::Auto => "auto",
        gearbox_ir::BindingMode::Local => "local",
        gearbox_ir::BindingMode::Remote => "remote",
    }
}

fn describe_preference(preference: &gearbox_ir::Preference) -> String {
    match preference {
        gearbox_ir::Preference::ExistingInfrastructure => "existing-infrastructure".to_owned(),
        gearbox_ir::Preference::FewerProcesses => "fewer-processes".to_owned(),
        gearbox_ir::Preference::Isolate { gear } => format!("isolate {gear}"),
    }
}
