//! Tests for plugin projection.
//!
//! The fixtures reproduce the shapes found in `gears-rust`; the real-tree tests
//! then prove the fixtures have not drifted from what they mirror.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;
use crate::scan::scan_crate;
use crate::test_corpus::require;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("fixture.rs"),
        relative: PathBuf::from("fixture.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

fn tree(rel: &str) -> Option<Vec<RustFile>> {
    let dir = crate::test_corpus::corpus(rel)?;
    Some(scan_crate(&dir).unwrap_or_else(|e| panic!("scan {rel}: {e}")))
}

fn idents(points: &[ExtensionPoint]) -> Vec<&str> {
    points.iter().map(|p| p.trait_ident.as_str()).collect()
}

// ---------------------------------------------------------------- points

#[test]
fn a_public_plugin_trait_is_an_extension_point() {
    let src = r"
        pub trait AuthNResolverPluginClient: Send + Sync {}
        pub trait AuthNResolverClient: Send + Sync {}   // public API, not a point
        trait PrivatePluginThing {}                      // not public
    ";
    assert_eq!(
        idents(&project_extension_points(&[file(src)])),
        vec!["AuthNResolverPluginClient"],
        "only public traits with `Plugin` in the ident; the public API trait is \
         what consumers use and is not an extension point"
    );
}

#[test]
fn a_crate_may_declare_several_points() {
    // mini-chat-sdk is the real instance of this.
    let src = r"
        pub trait MiniChatAuditPluginClientV1 {}
        pub trait MiniChatModelPolicyPluginClientV1 {}
    ";
    assert_eq!(
        idents(&project_extension_points(&[file(src)])),
        vec![
            "MiniChatAuditPluginClientV1",
            "MiniChatModelPolicyPluginClientV1"
        ]
    );
}

#[test]
fn points_come_from_the_real_sdks() {
    let authn = require!(tree("gears/system/authn-resolver/authn-resolver-sdk"));
    assert_eq!(
        idents(&project_extension_points(&authn)),
        vec!["AuthNResolverPluginClient"]
    );

    let mini = require!(tree("gears/mini-chat/mini-chat-sdk"));
    let points = project_extension_points(&mini);
    assert!(
        points.len() >= 2,
        "mini-chat declares two extension points, got {:?}",
        idents(&points)
    );
}

// ---------------------------------------------------------------- impls

fn points_of(idents: &[&str]) -> Vec<ExtensionPoint> {
    idents
        .iter()
        .map(|i| ExtensionPoint {
            trait_ident: (*i).to_owned(),
            relative: PathBuf::new(),
            line: 1,
        })
        .collect()
}

#[test]
fn a_plugin_fills_the_point_it_implements() {
    let src = r"
        #[async_trait]
        impl AuthNResolverPluginClient for Service {}
    ";
    let points = points_of(&["AuthNResolverPluginClient"]);
    assert_eq!(
        project_plugin_impl(&[file(src)], &points).unwrap(),
        Some("AuthNResolverPluginClient".to_owned())
    );
}

#[test]
fn a_gear_that_implements_no_point_is_not_a_plugin() {
    let src = "impl Gear for SomeGear {}";
    let points = points_of(&["AuthNResolverPluginClient"]);
    assert_eq!(project_plugin_impl(&[file(src)], &points).unwrap(), None);
}

#[test]
fn implementing_two_points_is_ambiguous_not_guessed() {
    let src = r"
        impl AuditPluginClientV1 for A {}
        impl PolicyPluginClientV1 for B {}
    ";
    let points = points_of(&["AuditPluginClientV1", "PolicyPluginClientV1"]);
    let err = project_plugin_impl(&[file(src)], &points).unwrap_err();
    assert_eq!(
        err,
        PluginImplError::Ambiguous {
            points: vec![
                "AuditPluginClientV1".to_owned(),
                "PolicyPluginClientV1".to_owned()
            ]
        },
        "which plugin this gear *is* has no single answer, so it must be reported"
    );
}

#[test]
fn real_plugins_fill_their_real_points() {
    let sdk = require!(tree("gears/system/authn-resolver/authn-resolver-sdk"));
    let points = project_extension_points(&sdk);

    for plugin in ["static-authn-plugin", "oidc-authn-plugin"] {
        let files = require!(tree(&format!(
            "gears/system/authn-resolver/plugins/{plugin}"
        )));
        assert_eq!(
            project_plugin_impl(&files, &points).unwrap(),
            Some("AuthNResolverPluginClient".to_owned()),
            "{plugin} must fill the point its SDK declares"
        );
    }
}

#[test]
fn the_host_itself_does_not_fill_its_own_point() {
    // A host consumes the point; it does not implement it. Getting this wrong
    // would make every host look like its own plugin.
    let sdk = require!(tree("gears/system/authn-resolver/authn-resolver-sdk"));
    let points = project_extension_points(&sdk);
    let host = require!(tree("gears/system/authn-resolver/authn-resolver"));
    assert_eq!(project_plugin_impl(&host, &points).unwrap(), None);
}

// ---------------------------------------------------------------- defaults

#[test]
fn vendor_default_from_an_impl_default_block() {
    let src = r#"
        pub struct StaticAuthNPluginConfig { pub vendor: String, pub priority: i16 }
        impl Default for StaticAuthNPluginConfig {
            fn default() -> Self {
                Self { vendor: "constructorfabric".to_owned(), priority: 100 }
            }
        }
    "#;
    assert_eq!(
        project_vendor_default(&[file(src)]),
        VendorDefault {
            vendor: Some("constructorfabric".to_owned()),
            priority: Some(100),
            unreadable: Vec::new(),
        }
    );
}

#[test]
fn vendor_default_from_a_serde_default_fn() {
    // The shape `oidc-authn-plugin` and `keycloak-idp-plugin` use. Reading only
    // `impl Default` would report "no default" for them, which is a wrong answer
    // rather than a gap: the mismatch check keys on the default.
    let src = r#"
        pub struct OidcAuthNGearConfig {
            #[serde(default = "default_vendor")]
            pub vendor: String,
            #[serde(default = "default_priority")]
            pub priority: u32,
        }
        fn default_vendor() -> String { "constructorfabric".to_owned() }
        fn default_priority() -> u32 { 100 }
    "#;
    assert_eq!(
        project_vendor_default(&[file(src)]),
        VendorDefault {
            vendor: Some("constructorfabric".to_owned()),
            priority: Some(100),
            unreadable: Vec::new(),
        }
    );
}

#[test]
fn a_config_with_no_default_reports_none() {
    let src = r"
        pub struct Thing { pub vendor: String }
    ";
    assert_eq!(
        project_vendor_default(&[file(src)]),
        VendorDefault::default()
    );
}

/// The shape `cluster::resolve_str_const` already reads for provider names.
/// Reporting it as "no default" would be a wrong answer, not a gap: a missing
/// default is what the vendor-mismatch check keys on.
#[test]
fn a_vendor_default_behind_a_const_resolves() {
    let src = r#"
        pub const DEFAULT_VENDOR: &str = "constructorfabric";
        pub struct XConfig { pub vendor: String }
        impl Default for XConfig {
            fn default() -> Self {
                Self { vendor: DEFAULT_VENDOR.to_owned() }
            }
        }
    "#;
    let got = project_vendor_default(&[file(src)]);
    assert_eq!(got.vendor.as_deref(), Some("constructorfabric"));
    assert!(got.unreadable.is_empty(), "got {:?}", got.unreadable);
}

/// The third answer. "The config declares no default" and "the default is there
/// and this could not read it" are different facts, and collapsing them made a
/// gear that compiles in a vendor look like one that does not.
#[test]
fn an_unreadable_initializer_is_recorded_rather_than_reported_as_absent() {
    let src = r"
        pub struct XConfig { pub vendor: String, pub priority: i16 }
        impl Default for XConfig {
            fn default() -> Self {
                Self { vendor: vendor_from_env(), priority: compute_priority() }
            }
        }
    ";
    let got = project_vendor_default(&[file(src)]);
    assert_eq!(got.vendor, None);
    assert_eq!(got.priority, None);
    // Sorted, so a catalogue built from the same tree is byte-identical.
    assert_eq!(got.unreadable, ["priority", "vendor"]);
}

/// `parse_nested_meta` stops at the first form it cannot model and loses every
/// later item in the same attribute, so the `default = "fn"` written after a
/// nested `rename(..)` was never seen and read as "no default fn".
#[test]
fn a_truncated_serde_attribute_does_not_read_as_no_default() {
    let src = r#"
        pub struct XConfig {
            #[serde(rename(serialize = "v", deserialize = "vendor"), default = "default_vendor")]
            pub vendor: String,
        }
        fn default_vendor() -> String { "constructorfabric".to_owned() }
    "#;
    let got = project_vendor_default(&[file(src)]);
    assert_eq!(
        got.unreadable,
        ["vendor"],
        "the attribute could not be read to its end, so `None` here is a gap and \
         not an answer: {got:?}"
    );
}

#[test]
fn real_vendor_defaults_are_read_in_both_shapes() {
    // static-authn uses `impl Default`; oidc uses `#[serde(default = ...)]`.
    // Both must come back with a vendor, or the mismatch check is blind on one.
    let static_authn = require!(tree(
        "gears/system/authn-resolver/plugins/static-authn-plugin"
    ));
    assert_eq!(
        project_vendor_default(&static_authn).vendor.as_deref(),
        Some("constructorfabric")
    );

    let oidc = require!(tree(
        "gears/system/authn-resolver/plugins/oidc-authn-plugin"
    ));
    assert_eq!(
        project_vendor_default(&oidc).vendor.as_deref(),
        Some("constructorfabric"),
        "the #[serde(default = ...)] shape must be read too"
    );

    let host = require!(tree("gears/system/authn-resolver/authn-resolver"));
    assert_eq!(
        project_vendor_default(&host).vendor.as_deref(),
        Some("constructorfabric"),
        "the host's selector default is read the same way"
    );
}

#[test]
fn the_account_management_defaults_really_do_disagree() {
    // The motivating case. account-management's selector defaults to
    // "constructorfabric" while neither IDP plugin does -- so on defaults alone
    // that host resolves nothing. This asserts the projection sees it.
    let host = require!(tree("gears/system/account-management/account-management"));
    let static_idp = require!(tree(
        "gears/system/account-management/plugins/static-idp-plugin"
    ));
    let keycloak = require!(tree(
        "gears/system/account-management/plugins/keycloak-idp-plugin"
    ));

    let host_vendor = project_vendor_default(&host).vendor;
    let plugin_vendors: Vec<Option<String>> = [&static_idp, &keycloak]
        .into_iter()
        .map(|files| project_vendor_default(files).vendor)
        .collect();

    // What the mismatch detection keys on: every plugin default, compared
    // against the host's selector. Spelling the three values out and then
    // comparing the literals with each other was an assertion that could only
    // fail if someone edited the assertion.
    assert!(
        host_vendor.is_some(),
        "the host compiles in a selector default, or there is nothing to mismatch"
    );
    assert!(
        plugin_vendors.iter().all(Option::is_some),
        "both plugins compile in a vendor: {plugin_vendors:?}"
    );
    assert!(
        plugin_vendors.iter().all(|v| *v != host_vendor),
        "no plugin default matches the host selector {host_vendor:?}, so on defaults \
         alone this host resolves nothing -- the silent misconfiguration GBX0512 \
         exists to catch. Got {plugin_vendors:?}"
    );
}
