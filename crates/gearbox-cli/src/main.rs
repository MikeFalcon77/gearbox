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

mod generate;
mod lock;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use gearbox_engine::{SourceRoot, check_plugins, load_catalogue, load_product};
use gearbox_ir::{Diagnostic, ProfileId, Severity, SourceId};

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

    /// Resolve a product for one deployment profile and print the lock.
    ///
    /// The mode of every contract binding is *derived* from where the gears end
    /// up, never declared, so the same description gives a different lock per
    /// profile. Nothing is written to disk: this prints, and `--format toml`
    /// prints exactly what a lock file would contain.
    Resolve {
        /// A source root to scan. Repeatable.
        #[arg(long, value_name = "DIR", required = true)]
        root: Vec<PathBuf>,

        /// The id to record for the source. Defaults to the root's directory name.
        #[arg(long, value_name = "ID")]
        source_id: Option<String>,

        /// The product description to resolve.
        #[arg(long, value_name = "FILE")]
        product: PathBuf,

        /// Which deployment profile. Defaults to the product's own default.
        #[arg(long, value_name = "ID")]
        profile: Option<String>,

        #[arg(long, value_enum, default_value_t = ResolveFormat::Text)]
        format: ResolveFormat,
    },

    /// Check everything that can be checked without resolving.
    ///
    /// Runs the catalogue load and reports its diagnostics with an exit code.
    /// With `--product`, also joins the product's selected gears against the
    /// catalogue -- the one check that needs both halves but not the resolver.
    ///
    /// Exits non-zero when any diagnostic is an error.
    Validate {
        /// A source root to scan. Repeatable; each is scanned in order.
        #[arg(long, value_name = "DIR", required = true)]
        root: Vec<PathBuf>,

        /// The id to record for the source. Defaults to the root's directory name.
        #[arg(long, value_name = "ID")]
        source_id: Option<String>,

        /// Also check a product description's gear selections.
        #[arg(long, value_name = "FILE")]
        product: Option<PathBuf>,

        #[arg(long, value_enum, default_value_t = Format::Text)]
        format: Format,
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

    /// Resolve a product and write its artefacts under `.gearbox/`.
    ///
    /// Resolves rather than reading an existing lock, so a preview can never be
    /// answering about a stale one. Composition output is never written into a
    /// source root: everything lands under `.gearbox/<product>/<profile>/`,
    /// including the `product.lock` the tree was generated from.
    Generate {
        /// A source root to scan. Repeatable.
        #[arg(long, value_name = "DIR", required = true)]
        root: Vec<PathBuf>,

        /// The id to record for the source. Defaults to the root's directory name.
        #[arg(long, value_name = "ID")]
        source_id: Option<String>,

        /// The product description to generate from.
        #[arg(long, value_name = "FILE")]
        product: PathBuf,

        /// Which deployment profile. Defaults to the product's own default.
        #[arg(long, value_name = "ID")]
        profile: Option<String>,

        /// Where to write. Defaults to `.gearbox/<product>/<profile>/`.
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// Report what would be written and write nothing
        /// (`cpt-gearbox-fr-generate-preview`).
        #[arg(long)]
        dry_run: bool,

        #[arg(long, value_enum, default_value_t = Format::Text)]
        format: Format,
    },

    /// Ask questions of a written `product.lock`.
    Lock {
        #[command(subcommand)]
        query: lock::LockQuery,
    },
}

/// What `resolve` prints.
#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
enum ResolveFormat {
    /// The canonical lock, byte-for-byte what would be written to disk.
    Toml,
    /// Machine-readable. The stable contract for tooling.
    Json,
    /// Human-readable summary.
    Text,
}

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
pub(crate) enum Format {
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
        Command::Resolve {
            root,
            source_id,
            product: product_file,
            profile,
            format,
        } => resolve_product(
            &root,
            source_id.as_deref(),
            &product_file,
            profile.as_deref(),
            format,
        ),
        Command::Validate {
            root,
            source_id,
            product: product_file,
            format,
        } => validate(&root, source_id.as_deref(), product_file.as_deref(), format),
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
        Command::Generate {
            root,
            source_id,
            product,
            profile,
            out,
            dry_run,
            format,
        } => generate::run(
            &root,
            source_id.as_deref(),
            &product,
            profile.as_deref(),
            out.as_deref(),
            dry_run,
            format,
        ),
        Command::Lock { query } => lock::run(&query),
    }
}

fn plugins(
    roots: &[PathBuf],
    gear: Option<&str>,
    product_file: Option<&std::path::Path>,
) -> anyhow::Result<ExitCode> {
    let opened = open_roots(roots, None)?;
    let scan = load_catalogue(&opened);

    // The catalogue's own diagnostics used to be dropped on the floor here, so
    // `plugins` listed extension points out of a half-loaded catalogue and
    // exited 0. `catalogue` and `validate` both report them; there is no reason
    // this command should not.
    report(scan.catalogue.diagnostics.as_slice());
    if scan.catalogue.diagnostics.has_errors() {
        return Ok(ExitCode::FAILURE);
    }

    if let Some(file) = product_file {
        return Ok(resolve_plugins(&scan.catalogue, file));
    }
    list_plugins(&scan.catalogue, gear);
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
    // Reported whether or not the product evaluated. A warning that arrives
    // *with* a usable intent used to be dropped, so plugin resolution could exit
    // 0 on a product description the same file's `product` subcommand complains
    // about.
    report(scan.diagnostics.as_slice());
    let product_failed = scan.diagnostics.has_errors();
    let Some(intent) = scan.intent else {
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
    if product_failed || diagnostics.has_errors() {
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
/// Open the roots a subcommand was given.
///
/// Shared with `catalogue` because opening them differently would make the two
/// commands disagree about what they are looking at.
pub(crate) fn open_roots(
    roots: &[PathBuf],
    source_id: Option<&str>,
) -> anyhow::Result<Vec<SourceRoot>> {
    let mut opened = Vec::with_capacity(roots.len());
    for path in roots {
        let id = match source_id {
            Some(id) => SourceId::new(id)?,
            None => SourceId::new(default_source_id(path))?,
        };
        opened.push(SourceRoot::open(id, path)?);
    }
    Ok(opened)
}

fn resolve_product(
    roots: &[PathBuf],
    source_id: Option<&str>,
    product_file: &std::path::Path,
    profile: Option<&str>,
    format: ResolveFormat,
) -> anyhow::Result<ExitCode> {
    let opened = open_roots(roots, source_id)?;
    let scan = load_catalogue(&opened);

    // Canonicalized so every diagnostic's `file://` URI points at a real path an
    // editor can open. A relative one renders and does nothing, which is the
    // failure the Studio's dead links already taught.
    let product_file = &product_file
        .canonicalize()
        .unwrap_or_else(|_| product_file.to_path_buf());
    let product_scan = gearbox_engine::product::load_product(product_file, None);
    let mut diagnostics: Vec<Diagnostic> = product_scan.diagnostics.as_slice().to_vec();
    let Some(intent) = product_scan.intent else {
        report(&diagnostics);
        anyhow::bail!("`{}` could not be evaluated", product_file.display());
    };

    // The product's own default when none is named, so the common invocation is
    // short and the answer still comes from the description rather than from a
    // guess made here.
    let profile = match profile {
        Some(id) => ProfileId::new(id)?,
        None => intent.default_profile.clone(),
    };

    let resolution =
        gearbox_engine::resolve::resolve_at(&scan.catalogue, &intent, &profile, Some(product_file));
    let sources = opened
        .iter()
        .map(|root| (root.id.clone(), root.to_resolved()))
        .collect();
    let resolved =
        gearbox_engine::resolve::product::assemble(&scan.catalogue, &intent, &resolution, sources);

    match format {
        // stdout carries the artifact; diagnostics go to stderr, so a pipe into
        // a file or `jq` gets exactly the artifact and nothing else.
        ResolveFormat::Toml => print!("{}", gearbox_lock::write_canonical(&resolved)?),
        ResolveFormat::Json => println!("{}", serde_json::to_string_pretty(&resolved)?),
        ResolveFormat::Text => print_resolution(&resolved),
    }

    diagnostics.extend(resolved.diagnostics.as_slice().iter().cloned());
    report(&diagnostics);

    Ok(if diagnostics.iter().any(|d| d.severity.is_error()) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

fn print_resolution(resolved: &gearbox_ir::ResolvedProduct) {
    println!(
        "{} {} for profile `{}` ({})",
        resolved.product.id,
        resolved.product.version,
        resolved.product.profile,
        resolved.product.profile_kind
    );
    println!("  {}", resolved.product.lock_hash);
    println!(
        "  {} gear(s) in {} process(es)",
        resolved.gears.len(),
        resolved.processes.len()
    );
    for process in &resolved.processes {
        println!(
            "    {} [{}] x{} -- {}",
            process.name,
            describe_kind(process.kind),
            process.replicas,
            process
                .gears
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if !resolved.bindings.is_empty() {
        println!("  bindings:");
        for b in &resolved.bindings {
            println!(
                "    {} -> {} : {} over {} via {}",
                b.consumer,
                b.provider,
                b.contract,
                b.transport.as_str(),
                describe_mechanism(b.mechanism)
            );
        }
    }
    if !resolved.cluster.is_empty() {
        println!("  cluster:");
        for c in &resolved.cluster {
            println!(
                "    {}/{} -> {}",
                c.scope,
                c.primitive.slug(),
                c.resolved.effective_provider()
            );
        }
    }
}

/// Written out rather than derived from `Debug`, which the workspace forbids in
/// output a person reads.
const fn describe_kind(kind: gearbox_ir::ProcessKind) -> &'static str {
    match kind {
        gearbox_ir::ProcessKind::Host => "host",
        gearbox_ir::ProcessKind::Worker => "worker",
    }
}

const fn describe_mechanism(mechanism: gearbox_ir::BindingMechanism) -> &'static str {
    match mechanism {
        gearbox_ir::BindingMechanism::ColocatedLocal => "co-located local",
        gearbox_ir::BindingMechanism::ConsumesStatic => "static endpoint",
        gearbox_ir::BindingMechanism::ConsumesDirectory => "directory",
        gearbox_ir::BindingMechanism::ProvidesClientWiring => "provider client wiring",
    }
}

fn validate(
    roots: &[PathBuf],
    source_id: Option<&str>,
    product_file: Option<&std::path::Path>,
    format: Format,
) -> anyhow::Result<ExitCode> {
    let opened = open_roots(roots, source_id)?;

    // The product is evaluated first so its own GBX01xx are reported even when
    // it cannot be used for the join. A product that does not evaluate is a
    // different failure from a product that names a gear nobody described, and
    // collapsing them would hide the first behind the second.
    let mut intent = None;
    let mut product_diagnostics = Vec::new();
    if let Some(path) = product_file {
        let scan = gearbox_engine::product::load_product(path, None);
        product_diagnostics.extend(scan.diagnostics.as_slice().iter().cloned());
        intent = scan.intent;
    }

    let checked = gearbox_engine::validate::validate_at(&opened, intent.as_ref(), product_file);

    let mut all: Vec<Diagnostic> = product_diagnostics;
    all.extend(checked.diagnostics.as_slice().iter().cloned());

    match format {
        Format::Json => {
            // stdout: the machine-readable contract.
            println!("{}", serde_json::to_string_pretty(&all)?);
        }
        Format::Text => {
            let errors = all.iter().filter(|d| d.severity.is_error()).count();
            let warnings = all
                .iter()
                .filter(|d| d.severity == gearbox_ir::Severity::Warning)
                .count();
            println!(
                "{} gear(s) checked from {} description file(s): {errors} error(s), \
                 {warnings} warning(s)",
                checked.scan.catalogue.gears.len(),
                checked.scan.files.len()
            );
            if let Some(path) = product_file {
                let selected = intent.as_ref().map_or(0, |i| i.selected_gears.len());
                println!("  product {}: {selected} selected gear(s)", path.display());
                // Per profile, because "is this point filled" only has an
                // answer once a profile is fixed.
                let filled = checked
                    .plugins
                    .iter()
                    .filter(|r| r.winner.is_some())
                    .count();
                if !checked.plugins.is_empty() {
                    println!(
                        "  plugins: {filled} of {} extension point/profile pair(s) resolve to an \
                         implementation",
                        checked.plugins.len()
                    );
                }
            }
        }
    }

    report(&all);

    Ok(if all.iter().any(|d| d.severity.is_error()) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

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
pub(crate) fn report(diagnostics: &[Diagnostic]) {
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
