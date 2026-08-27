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

use gearbox_ir::ContractKind;
use gearbox_ir::contract::strip_version_suffix;
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

/// Every `#[toolkit::contract]` trait in a scanned SDK crate.
///
/// A trait whose name matches no known suffix is skipped rather than guessed
/// at: the macro rejects it at compile time, so its presence would mean the
/// crate does not build and the catalogue has bigger problems.
#[must_use]
pub fn project_contracts(files: &[RustFile]) -> Vec<ProjectedContract> {
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
                let Ok(args) = attr.parse_args::<ContractArgs>() else {
                    continue;
                };
                let trait_ident = item_trait.ident.to_string();
                let Some(kind) = ContractKind::from_trait_name(&trait_ident) else {
                    continue;
                };
                let base_name = strip_version_suffix(&trait_ident).to_owned();
                out.push(ProjectedContract {
                    trait_ident,
                    base_name,
                    gear: args.gear,
                    version: args.version,
                    kind,
                    relative: file.relative.clone(),
                });
            }
        }
    }
    // Sorted so a catalogue built from the same tree is byte-identical.
    out.sort_by(|a, b| a.trait_ident.cmp(&b.trait_ident));
    out
}
