//! Projecting contract identity from `#[toolkit::contract]`.
//!
//! A contract's gear, version and kind are owned by the SDK crate that declares
//! the trait, not by whoever provides or consumes it. That is why `sdk` remains
//! a declared field in `gear.gdl`: it tells the projector which crate to scan,
//! which is not the same as restating what it will find there.
//!
//! The kind comes from the trait name's suffix, reusing
//! [`gearbox_ir::ContractKind::from_trait_name`] so GDL and the macro cannot
//! disagree about what `...Api` means.

use std::collections::BTreeSet;

use gearbox_ir::contract::strip_version_suffix;
use gearbox_ir::{ContractKind, Transport};
use syn::parse::{Parse, ParseStream};
use syn::{Ident, LitStr, Token};

use crate::scan::RustFile;

/// A contract as its own `#[toolkit::contract]` declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedContract {
    /// The trait identifier as written, e.g. `PaymentApiV2`. The join key a
    /// `provide`/`consume` uses to find this.
    pub trait_ident: String,
    /// The base name with any trailing major marker stripped, e.g. `PaymentApi`.
    pub base_name: String,
    /// `gear = "..."` -- the owning gear.
    pub gear: String,
    /// `version = "..."`, exactly as written.
    pub version: String,
    /// Derived from the trait name's suffix.
    pub kind: ContractKind,
    /// Which transports this contract can actually be bound over.
    ///
    /// Projected from which projection traits exist beside the base, never
    /// declared. The contract-binding design calls this a compile-time
    /// guarantee: "the absence of a transport projection is a compile-time
    /// guarantee that the contract is local-only [...] An Extension with no
    /// projection is provably local" (`toolkit-contract-binding/DESIGN.md`).
    ///
    /// Declaring it would let a description claim a remote binding that
    /// provably cannot exist, which is the one thing the structure of the code
    /// already rules out.
    pub transports: BTreeSet<Transport>,
    /// The file it was found in, relative to the crate's `src/`.
    pub relative: std::path::PathBuf,
}

/// `#[toolkit::contract(gear = "...", version = "...")]`.
struct ContractArgs {
    gear: String,
    version: String,
}

impl Parse for ContractArgs {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let mut gear = None;
        let mut version = None;
        while !input.is_empty() {
            let key: Ident = input.parse()?;
            input.parse::<Token![=]>()?;
            let value: LitStr = input.parse()?;
            match key.to_string().as_str() {
                "gear" => gear = Some(value.value()),
                "version" => version = Some(value.value()),
                // Both args are required by the macro, so anything else is a
                // future addition rather than a mistake; skip it.
                _ => {}
            }
            if input.peek(Token![,]) {
                input.parse::<Token![,]>()?;
            }
        }
        Ok(Self {
            gear: gear.ok_or_else(|| input.error("#[toolkit::contract] requires `gear`"))?,
            version: version
                .ok_or_else(|| input.error("#[toolkit::contract] requires `version`"))?,
        })
    }
}

/// What one `#[toolkit::provides]` on a gear states.
///
/// Distinct from [`ProjectedContract::transports`], and the distinction matters:
/// the SDK's projection traits say which transports the *contract* could be
/// bound over, while this says which of them *this provider* actually wires up.
/// `api-contracts` is the live example -- `PaymentApiGrpc` exists, so gRPC is
/// possible, but the gear declares `transports = [local, rest]` because the
/// gRPC client sits behind an opt-in Cargo feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedProvide {
    /// The contract trait's ident, from the `contract = path::Trait` argument.
    pub contract_ident: String,
    /// The transports this provider wires up. Always contains `Local`.
    pub transports: BTreeSet<Transport>,
}

/// Whether an attribute path is `provides` or `toolkit::provides`.
fn is_provides_attribute(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr
        .path()
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect();
    match segments.as_slice() {
        [one] => one == "provides",
        [first, second] => (first == "toolkit" || first == "gears_toolkit") && second == "provides",
        _ => false,
    }
}

/// Every `#[toolkit::provides]` on one gear item.
///
/// The attribute stacks: a gear providing two majors of the same family carries
/// one per major, which is why this returns a list keyed by contract ident.
///
/// # Errors
/// Returns the parse error rather than skipping an attribute it cannot read. An
/// earlier draft swallowed it, and the result was a provider that quietly came
/// back as local-only -- a plausible answer, and the wrong one. A shape this
/// cannot parse means the crate compiles and Gearbox does not understand it,
/// which is worth saying out loud.
pub fn project_provides(attrs: &[syn::Attribute]) -> syn::Result<Vec<ProjectedProvide>> {
    let mut out = Vec::new();
    for attr in attrs.iter().filter(|a| is_provides_attribute(a)) {
        let mut contract_ident = None;
        let mut transports = BTreeSet::new();

        // `parse_nested_meta` handles the `key = value` list; the values here are
        // a path and a bracketed ident list, so each is read by hand.
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("contract") {
                let path: syn::Path = meta.value()?.parse()?;
                contract_ident = path.segments.last().map(|s| s.ident.to_string());
            } else if meta.path.is_ident("transports") {
                // `meta.value()` consumes the `=`; bracketing `meta.input`
                // directly would try to read `= [..]` as a bracketed group and
                // fail the whole attribute silently.
                let value = meta.value()?;
                let content;
                syn::bracketed!(content in value);
                let idents =
                    syn::punctuated::Punctuated::<syn::Ident, syn::Token![,]>::parse_terminated(
                        &content,
                    )?;
                for ident in idents {
                    match ident.to_string().as_str() {
                        "local" => transports.insert(Transport::Local),
                        "rest" => transports.insert(Transport::Rest),
                        "grpc" => transports.insert(Transport::Grpc),
                        // Unknown spellings are a compile error in the macro, so
                        // seeing one here means the crate does not build.
                        _ => false,
                    };
                }
            } else if let Ok(value) = meta.value() {
                // `local`, `policies`, and anything added later: consumed so the
                // walk continues, since only transports are needed here. A bare
                // flag with no value is fine and leaves nothing to consume.
                value.parse::<syn::Expr>()?;
            }
            Ok(())
        })?;

        let contract_ident = contract_ident.ok_or_else(|| {
            syn::Error::new_spanned(attr, "#[toolkit::provides] with no `contract = ...`")
        })?;
        // A provider always has an in-process form.
        transports.insert(Transport::Local);
        out.push(ProjectedProvide {
            contract_ident,
            transports,
        });
    }
    Ok(out)
}

/// Whether an attribute path is `contract` or `toolkit::contract`.
fn is_contract_attribute(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr
        .path()
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect();
    match segments.as_slice() {
        [one] => one == "contract",
        [first, second] => (first == "toolkit" || first == "gears_toolkit") && second == "contract",
        _ => false,
    }
}

/// Whether `item_trait` extends `base` -- i.e. names it as a supertrait.
///
/// Checked rather than trusting the name: `PaymentApiRest: PaymentApi` is a
/// projection, while a coincidentally-named trait that does not extend the base
/// is not one, and treating it as one would put a transport in the catalogue
/// that no client can be generated for.
fn extends(item_trait: &syn::ItemTrait, base: &str) -> bool {
    item_trait.supertraits.iter().any(|bound| match bound {
        syn::TypeParamBound::Trait(t) => t.path.segments.last().is_some_and(|s| s.ident == base),
        _ => false,
    })
}

/// Which transports a contract can be bound over, from the traits beside it.
///
/// `Local` is unconditional: the base trait is the in-process binding, and a
/// compile-time implementation always satisfies it. Each remote transport is
/// present only if its projection trait exists *and* extends the base.
fn project_transports(files: &[RustFile], base: &str) -> BTreeSet<Transport> {
    let mut out = BTreeSet::new();
    out.insert(Transport::Local);

    for file in files {
        for item in &file.ast.items {
            let syn::Item::Trait(candidate) = item else {
                continue;
            };
            let ident = candidate.ident.to_string();
            // `PaymentApi` -> `PaymentApiRest`; `PaymentApiV2` -> `PaymentApiV2Rest`.
            let Some(suffix) = ident.strip_prefix(base) else {
                continue;
            };
            let transport = match suffix {
                "Rest" => Transport::Rest,
                "Grpc" => Transport::Grpc,
                _ => continue,
            };
            if extends(candidate, base) {
                out.insert(transport);
            }
        }
    }
    out
}

/// Every `#[toolkit::contract]` trait in a scanned SDK crate.
///
/// A trait whose name matches no known suffix is skipped rather than guessed
/// at: the macro rejects it at compile time, so its presence would mean the
/// crate does not build and the catalogue has bigger problems.
///
/// An attribute that does not *parse*, though, is propagated rather than
/// skipped -- for the same reason [`project_provides`] propagates one. Skipping
/// it would drop a contract the SDK really declares, and every `provide` and
/// `consume` naming that trait would then be reported as pointing at a trait
/// nobody wrote.
///
/// # Errors
/// Returns the [`syn::Error`] from the first `#[toolkit::contract]` whose
/// arguments do not parse.
pub fn project_contracts(files: &[RustFile]) -> syn::Result<Vec<ProjectedContract>> {
    let mut out = Vec::new();
    for file in files {
        for item in &file.ast.items {
            let syn::Item::Trait(item_trait) = item else {
                continue;
            };
            for attr in &item_trait.attrs {
                if !is_contract_attribute(attr) {
                    continue;
                }
                let args = attr.parse_args::<ContractArgs>()?;
                let trait_ident = item_trait.ident.to_string();
                let Some(kind) = ContractKind::from_trait_name(&trait_ident) else {
                    continue;
                };
                let base_name = strip_version_suffix(&trait_ident).to_owned();
                // Projections are named after the versioned ident, not the base:
                // `PaymentApiV2Rest`, not `PaymentApiRest`.
                let transports = project_transports(files, &trait_ident);
                out.push(ProjectedContract {
                    trait_ident,
                    base_name,
                    gear: args.gear,
                    version: args.version,
                    kind,
                    transports,
                    relative: file.relative.clone(),
                });
            }
        }
    }
    // Sorted so a catalogue built from the same tree is byte-identical.
    out.sort_by(|a, b| a.trait_ident.cmp(&b.trait_ident));
    Ok(out)
}

#[cfg(test)]
#[path = "contract_tests.rs"]
mod contract_tests;
