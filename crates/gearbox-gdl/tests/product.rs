//! Evaluating a `product.gdl`.
//!
//! The theme running through these: a product description declares every
//! deployment profile as *data* and is checked for what it can know about
//! itself. Whether a named gear or provider exists is the resolver's question,
//! and asking it here would mean a product file could not be edited until every
//! source it names had been scanned.

#![allow(
    clippy::unwrap_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use gearbox_gdl::{FileIdentity, GdlEngine};
use gearbox_ir::{DiagnosticCode, ProductIntent, ProfileId, RelPath, SourceId};

fn identity() -> FileIdentity {
    FileIdentity {
        uri: "file:///repo/products/demo/product.gdl".to_owned(),
        source: SourceId::new("product").unwrap(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        load_paths: None,
    }
}

fn eval(src: &str) -> (Option<ProductIntent>, Vec<DiagnosticCode>, String) {
    let out = GdlEngine::new().eval_product(&identity(), src);
    let codes = out.diagnostics.iter().map(|d| d.code).collect();
    let messages = out
        .diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect::<Vec<_>>()
        .join(" | ");
    (out.value, codes, messages)
}

/// A minimal well-formed product, with a hole for the field under test.
fn product(extra: &str) -> String {
    format!(
        r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "gears-rust", at = path("../gears-rust"))],
    profiles = [embedded(id = "dev"), kubernetes(id = "prod", discovery = "static")],
    default_profile = "dev",
    gears = [use_gear("api-gateway", source = "gears-rust")],
    {extra}
)
"#
    )
}

#[test]
fn a_minimal_product_evaluates() {
    let (intent, codes, messages) = eval(&product(""));
    assert!(codes.is_empty(), "{codes:?} {messages}");
    let intent = intent.unwrap();
    assert_eq!(intent.id, "demo");
    // `name` defaults to the id rather than being mandatory: a product that has
    // not been named yet is not an error worth blocking on.
    assert_eq!(intent.display_name, "demo");
    assert_eq!(intent.profiles.len(), 2);
}

#[test]
fn every_profile_is_data_and_scoping_selects_among_them() {
    let src = product(
        r#"bindings = [
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.remote,
                 transport = transport.rest, profiles = ["prod"]),
        ],"#,
    );
    let (intent, codes, messages) = eval(&src);
    assert!(codes.is_empty(), "{codes:?} {messages}");
    let intent = intent.unwrap();

    let dev = ProfileId::new("dev").unwrap();
    let prod = ProfileId::new("prod").unwrap();
    assert!(
        intent.bindings_for(&dev).is_empty(),
        "the binding is scoped to prod only"
    );
    assert_eq!(intent.bindings_for(&prod).len(), 1);
}

#[test]
fn an_unscoped_declaration_applies_to_every_profile() {
    let src = product(
        r#"bindings = [
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.auto),
        ],"#,
    );
    let (intent, codes, _) = eval(&src);
    assert!(codes.is_empty(), "{codes:?}");
    let intent = intent.unwrap();
    for id in intent.profiles.keys() {
        assert_eq!(
            intent.bindings_for(id).len(),
            1,
            "an empty `profiles` means every profile, not none"
        );
    }
}

// ---------------------------------------------------------------- GBX0110

#[test]
fn two_bindings_for_one_edge_in_one_profile_collide() {
    let src = product(
        r#"bindings = [
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.remote,
                 profiles = ["prod"]),
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.local,
                 profiles = ["prod"]),
        ],"#,
    );
    let (_, codes, messages) = eval(&src);
    assert!(
        codes.contains(&DiagnosticCode::GdlDuplicateProfileScoped),
        "one edge cannot be bound two ways at once: {codes:?} {messages}"
    );
}

#[test]
fn an_unscoped_binding_collides_with_a_scoped_one() {
    // The unscoped entry already claims every profile, so the second is a
    // contradiction rather than a narrowing.
    let src = product(
        r#"bindings = [
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.remote),
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.local,
                 profiles = ["prod"]),
        ],"#,
    );
    let (_, codes, messages) = eval(&src);
    assert!(
        codes.contains(&DiagnosticCode::GdlDuplicateProfileScoped),
        "{codes:?} {messages}"
    );
}

#[test]
fn disjoint_profile_scopes_do_not_collide() {
    // The whole point of profile-scoping: the same edge may resolve differently
    // per profile, which must not read as a duplicate.
    let src = product(
        r#"bindings = [
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.local,
                 profiles = ["dev"]),
            bind(consumer = "c", contract = "p/Api@v1", mode = binding_mode.remote,
                 profiles = ["prod"]),
        ],"#,
    );
    let (_, codes, messages) = eval(&src);
    assert!(codes.is_empty(), "{codes:?} {messages}");
}

#[test]
fn one_cluster_scope_bound_twice_in_a_profile_collides() {
    let src = product(
        r#"cluster_profiles = [
            cluster_profile(name = "event-broker", cache = provider("standalone"),
                            profiles = ["dev"]),
            cluster_profile(name = "event-broker", cache = provider("postgres"),
                            profiles = ["dev"]),
        ],"#,
    );
    let (_, codes, messages) = eval(&src);
    assert!(
        codes.contains(&DiagnosticCode::GdlDuplicateProfileScoped),
        "one scope resolves to one backend per profile: {codes:?} {messages}"
    );
}

#[test]
fn a_duplicate_profile_id_collides() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = path("."))],
    profiles = [embedded(id = "dev"), embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear("g", source = "s")],
)
"#;
    let (_, codes, messages) = eval(src);
    assert!(
        codes.contains(&DiagnosticCode::GdlDuplicateProfileScoped),
        "{codes:?} {messages}"
    );
}

// ---------------------------------------------------------------- references

#[test]
fn default_profile_must_name_a_declared_profile() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "nope",
    gears = [use_gear("g", source = "s")],
)
"#;
    let (intent, _, messages) = eval(src);
    assert!(intent.is_none(), "an unresolvable default cannot be used");
    assert!(
        messages.contains("nope") && messages.contains("dev"),
        "the message must name both the bad value and the choices: {messages}"
    );
}

#[test]
fn scoping_to_an_undeclared_profile_is_reported() {
    let src =
        product(r#"processes = [process("p", anchor = "api-gateway", profiles = ["staging"])],"#);
    let (_, _, messages) = eval(&src);
    assert!(
        messages.contains("staging") && messages.contains("not declared"),
        "{messages}"
    );
}

#[test]
fn a_gear_from_an_undeclared_source_is_reported() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear("g", source = "other")],
)
"#;
    let (_, _, messages) = eval(src);
    assert!(messages.contains("other"), "{messages}");
}

#[test]
fn a_registry_source_is_refused_by_name() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = registry(package = "cf-gears-thing", version = "1"))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [],
)
"#;
    let (_, codes, messages) = eval(src);
    assert!(
        codes.contains(&DiagnosticCode::GapRegistrySource),
        "registry() is spelled in the vocabulary so this can be named rather than \
         reported as a typo: {codes:?} {messages}"
    );
}

#[test]
fn git_must_pin_something() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = git(url = "https://example.com/x.git"))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [],
)
"#;
    let (_, _, messages) = eval(src);
    assert!(messages.contains("pins nothing"), "{messages}");
}

#[test]
fn a_branch_is_accepted_but_recorded_as_not_immutable() {
    let src = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = git(url = "https://example.com/x.git", branch = "main"))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [],
)
"#;
    let (intent, codes, messages) = eval(src);
    assert!(codes.is_empty(), "{codes:?} {messages}");
    let intent = intent.unwrap();
    let source = intent.sources.values().next().unwrap();
    assert!(
        !source.is_immutable(),
        "a branch makes the lock repeatable but not reproducible, and the IR says so"
    );
}

// ---------------------------------------------------------------- provider options

#[test]
fn provider_options_become_json_and_sort_stably() {
    let src = product(
        r#"cluster_profiles = [
            cluster_profile(name = "s", cache = provider("postgres",
                schema = "cluster", pool_max_size = 10, tls = True)),
        ],"#,
    );
    let (intent, codes, messages) = eval(&src);
    assert!(codes.is_empty(), "{codes:?} {messages}");
    let intent = intent.unwrap();
    let options = &intent.cluster_scopes[0].cache.options;

    // A BTreeMap in the IR, so order is by key regardless of how it was typed.
    let keys: Vec<&str> = options.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["pool_max_size", "schema", "tls"]);
    assert_eq!(options["pool_max_size"], serde_json::json!(10));
    assert_eq!(options["schema"], serde_json::json!("cluster"));
    assert_eq!(options["tls"], serde_json::json!(true));
}

#[test]
fn a_non_json_option_is_refused_rather_than_nulled() {
    // `None` would encode as JSON null, and the lock is TOML, which has no null.
    let src = product(
        r#"cluster_profiles = [
            cluster_profile(name = "s", cache = provider("postgres", schema = None)),
        ],"#,
    );
    let (_, _, messages) = eval(&src);
    assert!(
        messages.contains("schema") && messages.contains("not a string"),
        "{messages}"
    );
}

#[test]
fn a_cluster_scope_without_a_cache_is_refused() {
    // The cache is the anchor the SDK compare-and-swap defaults are layered
    // over, so a scope without one has nothing to fall back to.
    let src = product(
        r#"cluster_profiles = [cluster_profile(name = "s", lock = provider("postgres"))],"#,
    );
    let (_, codes, _) = eval(&src);
    assert!(
        !codes.is_empty(),
        "omitting the mandatory `cache` must be refused"
    );
}

// ---------------------------------------------------------------- surfaces

#[test]
fn gear_is_not_callable_in_a_product() {
    // Separate global sets, so a file that mixes the two fails at the call
    // rather than producing half of each.
    let (_, _, messages) = eval(r#"gear(package = cargo(crate_name = "c", lib = "c"))"#);
    assert!(
        messages.contains("gear"),
        "expected an unbound-name error naming `gear`: {messages}"
    );
}

#[test]
fn a_file_with_no_product_is_a_cardinality_error() {
    let (_, codes, _) = eval("X = 1\n");
    assert_eq!(codes, vec![DiagnosticCode::GdlCardinality]);
}

#[test]
fn two_products_in_one_file_is_a_cardinality_error() {
    let src = format!("{}\n{}", product(""), product(""));
    let (_, codes, _) = eval(&src);
    assert!(codes.contains(&DiagnosticCode::GdlCardinality), "{codes:?}");
}

#[test]
fn a_product_is_held_to_the_same_declarative_standard() {
    let (_, codes, _) = eval(
        r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "s", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear(g, source = "s") for g in ["a", "b"]],
)
"#,
    );
    // Every forbidden construct is reported, not just the first -- a file full
    // of conditionals should list them all -- so assert the code, not the count.
    assert!(
        !codes.is_empty(),
        "the comprehension ban is not gear-specific"
    );
    assert!(
        codes
            .iter()
            .all(|c| *c == DiagnosticCode::GdlForbiddenConstruct),
        "{codes:?}"
    );
}

#[test]
fn an_unknown_argument_is_refused_not_ignored() {
    let (_, codes, _) = eval(&product(r"replicas = 3,"));
    assert_eq!(codes, vec![DiagnosticCode::GdlUnknownArgument]);
}

#[test]
fn preferences_deduplicate() {
    let src = product(
        r#"preferences = [prefer.fewer_processes(), prefer.fewer_processes(),
                          prefer.isolate(gear = "api-gateway")],"#,
    );
    let (intent, codes, messages) = eval(&src);
    assert!(codes.is_empty(), "{codes:?} {messages}");
    assert_eq!(intent.unwrap().preferences.len(), 2);
}

#[test]
fn a_process_with_zero_replicas_is_refused() {
    let src = product(r#"processes = [process("p", anchor = "api-gateway", replicas = 0)],"#);
    let (_, _, messages) = eval(&src);
    assert!(messages.contains("does not run"), "{messages}");
}
