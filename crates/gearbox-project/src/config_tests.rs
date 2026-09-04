//! Tests for configuration projection.
//!
//! Fixtures reproduce the shapes `gears-rust` actually uses; the real-tree tests
//! below then prove the fixtures have not drifted from what they mirror. Both
//! halves matter: a fixture that has drifted passes while the corpus fails, and
//! a corpus test alone cannot run where the corpus is absent.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use gearbox_ir::ConfigFieldType;

use super::*;
use crate::scan::scan_crate;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("fixture.rs"),
        relative: PathBuf::from("fixture.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

fn tree(rel: &str) -> Option<Vec<RustFile>> {
    let dir = crate::test_corpus::corpus(rel)?;
    scan_crate(&dir).ok()
}

macro_rules! require {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => {
                eprintln!("skipping: ../gears-rust not present");
                return;
            }
        }
    };
}

fn named<'a>(fields: &'a [ConfigField], name: &str) -> &'a ConfigField {
    fields
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("no field `{name}` in {:?}", names(fields)))
}

fn names(fields: &[ConfigField]) -> Vec<&str> {
    fields.iter().map(|f| f.name.as_str()).collect()
}

// -- finding the struct ----------------------------------------------------

#[test]
fn the_turbofish_spelling_names_the_config_type() {
    let files = [file(
        r"
        impl Gear for ApiGateway {
            async fn init(&self, ctx: &GearCtx) -> Result<()> {
                let cfg = ctx.config_or_default::<crate::config::ApiGatewayConfig>()?;
                Ok(())
            }
        }
        ",
    )];
    assert_eq!(
        project_config_root(&files),
        Ok(Some("ApiGatewayConfig".to_owned()))
    );
}

/// Ten of the eleven configured gears write it this way, so reading only the
/// turbofish would report "no configuration" for almost the whole corpus.
#[test]
fn the_annotated_binding_spelling_names_it_too() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct GrpcHubConfig { pub listen_addr: String }

        impl Gear for GrpcHub {
            async fn init(&self, ctx: &GearCtx) -> Result<()> {
                let cfg: GrpcHubConfig = ctx.config_or_default()?;
                Ok(())
            }
        }
        ",
    )];
    assert_eq!(
        project_config_root(&files),
        Ok(Some("GrpcHubConfig".to_owned()))
    );
}

#[test]
fn a_gear_that_reads_no_config_has_no_root() {
    let files = [file(
        r"
        impl Gear for Orchestrator {
            async fn init(&self, _ctx: &GearCtx) -> Result<()> { Ok(()) }
        }
        ",
    )];
    assert_eq!(project_config_root(&files), Ok(None));
}

#[test]
fn two_config_types_are_ambiguous_rather_than_guessed() {
    let files = [file(
        r"
        pub struct AlphaConfig { pub a: String }
        fn a(ctx: &GearCtx) { let _: AlphaConfig = ctx.config_or_default().unwrap(); }
        fn b(ctx: &GearCtx) { let _ = ctx.config::<BetaConfig>().unwrap(); }
        ",
    )];
    assert_eq!(
        project_config_root(&files),
        Err(ConfigRootError::Ambiguous {
            roots: vec!["AlphaConfig".to_owned(), "BetaConfig".to_owned()],
        })
    );
}

// -- classifying fields ----------------------------------------------------

#[test]
fn scalars_are_classified_and_everything_else_is_complex() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct DemoConfig {
            pub bind_addr: String,
            pub enabled: bool,
            pub port: u16,
            pub ratio: f64,
            pub tags: Vec<String>,
            pub nested: Inner,
        }
        #[derive(Deserialize)]
        pub struct Inner { pub a: String }
        ",
    )];
    let fields = project_config_fields(&files, "DemoConfig");
    assert_eq!(
        names(&fields),
        ["bind_addr", "enabled", "port", "ratio", "tags", "nested"]
    );
    assert_eq!(named(&fields, "bind_addr").ty, ConfigFieldType::Str);
    assert_eq!(named(&fields, "enabled").ty, ConfigFieldType::Bool);
    assert_eq!(named(&fields, "port").ty, ConfigFieldType::Int);
    assert_eq!(named(&fields, "ratio").ty, ConfigFieldType::Float);
    assert_eq!(named(&fields, "tags").ty, ConfigFieldType::Complex);
    assert_eq!(named(&fields, "nested").ty, ConfigFieldType::Complex);
}

/// The whole point of §8 of the plan: a new enum must not need a Gearbox
/// release, so the variants travel as data read from the enum itself.
#[test]
fn a_unit_enum_projects_its_variants_through_rename_all() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        pub struct DemoConfig { pub mode: AuthNMode }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "snake_case")]
        pub enum AuthNMode {
            #[default]
            AcceptAll,
            StaticTokens,
        }
        "#,
    )];
    let fields = project_config_fields(&files, "DemoConfig");
    assert_eq!(
        named(&fields, "mode").ty,
        ConfigFieldType::Enum {
            variants: vec!["accept_all".to_owned(), "static_tokens".to_owned()],
        }
    );
}

#[test]
fn an_enum_with_data_carrying_variants_is_complex() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        pub struct DemoConfig { pub auth: InternalAuthConfig }

        #[derive(Deserialize)]
        #[serde(tag = "provider", rename_all = "snake_case")]
        pub enum InternalAuthConfig {
            SharedSecret { secret: String },
            Kube { audiences: Vec<String> },
        }
        "#,
    )];
    assert_eq!(
        named(&project_config_fields(&files, "DemoConfig"), "auth").ty,
        ConfigFieldType::Complex
    );
}

/// `InternalAuthEnforcement` lives in `libs/toolkit-transport-grpc`, outside the
/// crate scan. Degrading to "no control" is the honest answer; inventing the
/// variants would write values the gear rejects.
#[test]
fn an_enum_defined_outside_the_scan_degrades_instead_of_guessing() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct DemoConfig { pub enforcement: InternalAuthEnforcement }
        ",
    )];
    assert_eq!(
        named(&project_config_fields(&files, "DemoConfig"), "enforcement").ty,
        ConfigFieldType::Complex
    );
}

#[test]
fn a_renamed_field_projects_under_its_wire_name() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        pub struct TenantConfig {
            #[serde(rename = "type", default)]
            pub tenant_type: Option<String>,
        }
        "#,
    )];
    let fields = project_config_fields(&files, "TenantConfig");
    assert_eq!(names(&fields), ["type"]);
}

#[test]
fn a_custom_codec_is_complex_rather_than_its_rust_type() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        pub struct CacheSettings {
            #[serde(with = "toolkit_utils::humantime_serde::option")]
            pub ttl: Option<Duration>,
        }
        "#,
    )];
    assert_eq!(
        named(&project_config_fields(&files, "CacheSettings"), "ttl").ty,
        ConfigFieldType::Complex
    );
}

#[test]
fn a_secret_typed_field_is_flagged() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct TokenMapping { pub token: SecretString }
        ",
    )];
    let fields = project_config_fields(&files, "TokenMapping");
    assert!(named(&fields, "token").secret);
    assert_eq!(named(&fields, "token").ty, ConfigFieldType::Str);
}

#[test]
fn a_skipped_field_is_not_part_of_the_surface() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct DemoConfig {
            pub kept: String,
            #[serde(skip)]
            pub dropped: String,
        }
        ",
    )];
    assert_eq!(
        names(&project_config_fields(&files, "DemoConfig")),
        ["kept"]
    );
}

// -- required and defaults -------------------------------------------------

#[test]
fn required_follows_serde_rather_than_the_type() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        pub struct DemoConfig {
            pub must: String,
            #[serde(default)]
            pub has_default: String,
            #[serde(default = "d")]
            pub has_fn: String,
            pub maybe: Option<String>,
        }
        fn d() -> String { "from-fn".to_owned() }
        "#,
    )];
    let fields = project_config_fields(&files, "DemoConfig");
    assert!(named(&fields, "must").required);
    assert!(!named(&fields, "has_default").required);
    assert!(!named(&fields, "has_fn").required);
    // serde's `missing_field` succeeds for a type that deserializes from
    // nothing, so an `Option` is optional without a `default` saying so.
    assert!(!named(&fields, "maybe").required);
}

#[test]
fn a_container_default_makes_every_field_optional() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        #[serde(default, deny_unknown_fields)]
        pub struct AuthNResolverConfig { pub vendor: String }
        ",
    )];
    assert!(
        !named(
            &project_config_fields(&files, "AuthNResolverConfig"),
            "vendor"
        )
        .required
    );
}

/// Both spellings of "the default", because both are in the tree -- the same
/// hazard `project_vendor_default` already had to learn.
#[test]
fn defaults_are_read_from_a_default_impl_and_from_a_serde_fn() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        #[serde(default)]
        pub struct DemoConfig {
            pub vendor: String,
            #[serde(default = "default_priority")]
            pub priority: u32,
            #[serde(default = "yes")]
            pub enabled: bool,
        }
        impl Default for DemoConfig {
            fn default() -> Self {
                Self { vendor: "constructorfabric".to_owned(), priority: 100, enabled: true }
            }
        }
        fn default_priority() -> u32 { 42 }
        fn yes() -> bool { true }
        "#,
    )];
    let fields = project_config_fields(&files, "DemoConfig");
    assert_eq!(
        named(&fields, "vendor").default,
        Some(serde_json::Value::String("constructorfabric".to_owned()))
    );
    // The `serde(default = ...)` fn wins over the `Default` impl: it is what
    // serde actually calls for that field.
    assert_eq!(
        named(&fields, "priority").default,
        Some(serde_json::Value::from(42))
    );
    assert_eq!(
        named(&fields, "enabled").default,
        Some(serde_json::Value::Bool(true))
    );
}

/// Three defaults that were wrong before they were read off the real corpus, and
/// each was wrong in the same way: a path is a *name*, not a value.
#[test]
fn a_path_default_is_resolved_or_omitted_but_never_reported_as_its_own_name() {
    let files = [file(
        r#"
        #[derive(Deserialize)]
        #[serde(default)]
        pub struct DemoConfig {
            pub advertise_addr: Option<String>,
            pub ttl_secs: u64,
            pub mode: AuthNMode,
        }

        impl Default for DemoConfig {
            fn default() -> Self {
                Self {
                    advertise_addr: None,
                    ttl_secs: DEFAULT_TTL_SECS,
                    mode: AuthNMode::AcceptAll,
                }
            }
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum AuthNMode { AcceptAll, StaticTokens }
        "#,
    )];
    let fields = project_config_fields(&files, "DemoConfig");

    // `None` is the absence of a default, not the string "None".
    assert_eq!(named(&fields, "advertise_addr").default, None);
    // A `const` is a name this cannot resolve; reporting the identifier as the
    // value would put `DEFAULT_TTL_SECS` in a number box.
    assert_eq!(named(&fields, "ttl_secs").default, None);
    // An enum default is written in Rust and read in YAML, so it is spelled as
    // the wire spells it -- and as its own variants list spells it.
    assert_eq!(
        named(&fields, "mode").default,
        Some(serde_json::Value::String("accept_all".to_owned()))
    );
}

#[test]
fn a_unit_struct_has_no_surface() {
    let files = [file(
        r"#[derive(Deserialize)] pub struct ApiContractsConfig;",
    )];
    assert!(project_config_fields(&files, "ApiContractsConfig").is_empty());
}

#[test]
fn an_unknown_root_projects_nothing() {
    let files = [file(r"pub struct Other { pub a: String }")];
    assert!(project_config_fields(&files, "NoSuchConfig").is_empty());
}

#[test]
fn the_doc_comment_travels_as_the_operator_facing_prose() {
    let files = [file(
        r"
        #[derive(Deserialize)]
        pub struct DemoConfig {
            /// Listen address for the gRPC server.
            pub listen_addr: String,
        }
        ",
    )];
    assert_eq!(
        named(&project_config_fields(&files, "DemoConfig"), "listen_addr")
            .doc
            .as_deref(),
        Some("Listen address for the gRPC server.")
    );
}

// -- against the real tree -------------------------------------------------

#[test]
fn api_gateway_projects_its_scalars_from_the_real_crate() {
    let files = require!(tree("gears/system/api-gateway"));
    let root = project_config_root(&files).expect("one config type");
    assert_eq!(root.as_deref(), Some("ApiGatewayConfig"));

    let fields = project_config_fields(&files, "ApiGatewayConfig");
    assert_eq!(named(&fields, "bind_addr").ty, ConfigFieldType::Str);
    // The only field with neither a container nor a field default.
    assert!(named(&fields, "bind_addr").required);
    assert_eq!(named(&fields, "enable_docs").ty, ConfigFieldType::Bool);
    assert!(!named(&fields, "enable_docs").required);
    assert_eq!(
        named(&fields, "healthcheck_timeout_ms").ty,
        ConfigFieldType::Int
    );
    // Nested structures carry no control.
    assert_eq!(named(&fields, "openapi").ty, ConfigFieldType::Complex);
    assert_eq!(named(&fields, "defaults").ty, ConfigFieldType::Complex);
}

/// `grpc-hub` keeps its config struct in `src/gear.rs`, so any rule that looked
/// for `src/config.rs` would silently report this gear as unconfigured.
#[test]
fn grpc_hub_is_found_although_its_struct_is_not_in_config_rs() {
    let files = require!(tree("gears/system/grpc-hub"));
    assert_eq!(
        project_config_root(&files)
            .expect("one config type")
            .as_deref(),
        Some("GrpcHubConfig")
    );
    let fields = project_config_fields(&files, "GrpcHubConfig");
    assert_eq!(named(&fields, "listen_addr").ty, ConfigFieldType::Str);
    assert_eq!(
        named(&fields, "internal_auth_cache_ttl_secs").ty,
        ConfigFieldType::Int
    );
}

#[test]
fn static_authn_plugin_projects_its_mode_enum_from_the_real_crate() {
    let files = require!(tree(
        "gears/system/authn-resolver/plugins/static-authn-plugin"
    ));
    let fields = project_config_fields(&files, "StaticAuthNPluginConfig");
    assert_eq!(
        named(&fields, "mode").ty,
        ConfigFieldType::Enum {
            variants: vec!["accept_all".to_owned(), "static_tokens".to_owned()],
        }
    );
    assert_eq!(
        named(&fields, "vendor").default,
        Some(serde_json::Value::String("constructorfabric".to_owned()))
    );
}

#[test]
fn tenant_resolver_projects_its_single_vendor_field() {
    let files = require!(tree("gears/system/tenant-resolver/tenant-resolver"));
    assert_eq!(
        project_config_root(&files)
            .expect("one config type")
            .as_deref(),
        Some("TenantResolverConfig")
    );
    let fields = project_config_fields(&files, "TenantResolverConfig");
    assert_eq!(names(&fields), ["vendor"]);
    assert_eq!(
        named(&fields, "vendor").default,
        Some(serde_json::Value::String("constructorfabric".to_owned()))
    );
}

/// A gear whose whole configuration is one map gets no typed controls at all,
/// and that is the right answer rather than a gap to fill with string boxes.
///
/// **`cluster` and not `types-registry`, and the difference is a lesson.** This
/// asserted both until `types-registry` grew an `allow_compatibility_force:
/// bool` upstream and the test failed for a change that was none of its
/// business. A corpus test may assert what the projector reads; it may not
/// assert what someone else's struct is allowed to contain.
#[test]
fn a_configuration_that_is_all_collections_offers_no_controls() {
    let cluster = require!(tree("gears/system/cluster/cluster"));
    let fields = project_config_fields(&cluster, "ClusterConfig");
    assert!(!fields.is_empty(), "the struct is found");
    assert!(
        fields.iter().all(|f| f.ty == ConfigFieldType::Complex),
        "expected every field complex, got {fields:?}"
    );
}

/// The collection fields of `types-registry` carry no control, whatever else
/// the struct grows around them.
#[test]
fn a_vec_field_in_the_real_corpus_is_complex() {
    let files = require!(tree("gears/system/types-registry/types-registry"));
    let fields = project_config_fields(&files, "TypesRegistryConfig");
    for name in ["entity_id_fields", "schema_id_fields", "entities"] {
        assert_eq!(
            named(&fields, name).ty,
            ConfigFieldType::Complex,
            "`{name}` is a list and carries no control"
        );
    }
}

#[test]
fn gear_orchestrator_reads_no_config_at_all() {
    let files = require!(tree("gears/system/gear-orchestrator"));
    assert_eq!(project_config_root(&files), Ok(None));
}

/// The deep search finds the call wherever it sits, so the binding's type is
/// only believed when it names a struct -- otherwise a chained call would
/// record whatever the expression happened to end up as.
#[test]
fn a_binding_that_is_not_a_struct_is_not_mistaken_for_the_config_type() {
    let files = [file(
        r"
        pub struct DemoConfig { pub a: String }
        fn f(ctx: &GearCtx) {
            let _len: usize = ctx.config::<DemoConfig>().unwrap().a.len();
        }
        ",
    )];
    assert_eq!(
        project_config_root(&files),
        Ok(Some("DemoConfig".to_owned()))
    );
}
