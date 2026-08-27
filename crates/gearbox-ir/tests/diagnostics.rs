//! The diagnostic catalogue is itself checked.
//!
//! These tests are the enforcement mechanism for two PRD requirements that would
//! otherwise rely on review discipline:
//!
//! - `cpt-gearbox-nfr-actionable-diagnostics` -- every error carries a remedy.
//! - `cpt-gearbox-nfr-evidence-cited` -- every claim about a runtime limitation
//!   cites the source that proves it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file; a fixture builder that propagates errors instead of \
              panicking obscures the assertion it exists to support"
)]

use std::collections::BTreeSet;

use gearbox_ir::{
    Diagnostic, DiagnosticCode, DiagnosticDomain, Diagnostics, Location, Range, RelatedLocation,
    Severity,
};

#[test]
fn retired_codes_are_not_reused() {
    // GBX0201-GBX0205 were retired when the catalogue became macro-projected.
    // Reusing a number would make a lock or a transcript that names GBX0203
    // silently mean something else.
    let live: Vec<&str> = DiagnosticCode::ALL.iter().map(|c| c.as_str()).collect();
    for retired in ["GBX0201", "GBX0202", "GBX0203", "GBX0204", "GBX0205"] {
        assert!(
            !live.contains(&retired),
            "{retired} was retired with the macro-projected catalogue and must not be reused"
        );
    }
    // And their replacements are present.
    for live_code in [
        "GBX0206", "GBX0207", "GBX0208", "GBX0209", "GBX0210", "GBX0211",
    ] {
        assert!(live.contains(&live_code), "{live_code} should exist");
    }
}

#[test]
fn codes_are_unique() {
    let mut seen = BTreeSet::new();
    for code in DiagnosticCode::ALL {
        assert!(
            seen.insert(code.as_str()),
            "duplicate diagnostic code `{}`",
            code.as_str()
        );
    }
    assert_eq!(seen.len(), DiagnosticCode::ALL.len());
}

#[test]
fn code_strings_are_well_formed() {
    for code in DiagnosticCode::ALL {
        let s = code.as_str();
        assert_eq!(s.len(), 7, "`{s}` should be GBX plus four digits");
        assert!(s.starts_with("GBX"), "`{s}` should start with GBX");
        assert!(
            s[3..].bytes().all(|b| b.is_ascii_digit()),
            "`{s}` should end in four digits"
        );
    }
}

#[test]
fn numeric_range_agrees_with_domain() {
    // A reader should be able to place a code from its number alone, without
    // consulting a table.
    for code in DiagnosticCode::ALL {
        let hundreds: u32 = code.as_str()[3..5].parse().unwrap();
        let expected = match hundreds {
            1 => DiagnosticDomain::Gdl,
            2 => DiagnosticDomain::Validate,
            3 => DiagnosticDomain::Topology,
            4 => DiagnosticDomain::Binding,
            5 => DiagnosticDomain::Cluster,
            6 => DiagnosticDomain::RuntimeGap,
            7 => DiagnosticDomain::Generator,
            other => panic!("`{}` uses undeclared range {other}xx", code.as_str()),
        };
        assert_eq!(
            code.domain(),
            expected,
            "`{}` is in the {hundreds}xx range but claims domain {:?}",
            code.as_str(),
            code.domain()
        );
    }
}

#[test]
fn every_code_has_a_title() {
    for code in DiagnosticCode::ALL {
        let title = code.title();
        assert!(!title.trim().is_empty(), "`{code}` has no title");
        assert!(
            !title.ends_with('.'),
            "`{code}` title should read as a label, not a sentence: {title:?}"
        );
    }
}

#[test]
fn every_runtime_gap_code_requires_evidence() {
    // The whole point of the runtime-gap range is that it makes claims about
    // another repository. Those claims must be checkable.
    for code in DiagnosticCode::ALL
        .iter()
        .filter(|c| c.domain() == DiagnosticDomain::RuntimeGap)
    {
        // The one exception is the registry-source refusal, which is a scope
        // decision of this tool, not a statement about the runtime.
        if *code == DiagnosticCode::GapRegistrySource {
            continue;
        }
        assert!(
            code.requires_evidence(),
            "`{code}` asserts a runtime limitation but does not require evidence"
        );
    }
}

#[test]
fn codes_round_trip_through_their_string_form() {
    for code in DiagnosticCode::ALL {
        assert_eq!(DiagnosticCode::parse(code.as_str()).unwrap(), *code);
        let json = serde_json::to_string(code).unwrap();
        assert_eq!(json, format!("\"{}\"", code.as_str()));
        assert_eq!(
            serde_json::from_str::<DiagnosticCode>(&json).unwrap(),
            *code
        );
    }
    assert!(DiagnosticCode::parse("GBX9999").is_err());
    assert!(serde_json::from_str::<DiagnosticCode>("\"nope\"").is_err());
}

#[test]
fn errors_cannot_be_built_without_a_remedy() {
    // `Diagnostic::error` takes the remedy as a parameter, so an actionless
    // error is not expressible. This test pins that down against the validator.
    let d = Diagnostic::error(
        DiagnosticCode::BindingNoProvider,
        "no gear provides `api-contracts/PaymentApi@v1`, consumed by `payments-audit`",
        "add a gear providing it, or drop the consumption",
    );
    assert!(d.is_error());
    assert!(d.validate().is_ok());

    // Going around the constructor is caught.
    let bad = Diagnostic::new(DiagnosticCode::BindingNoProvider, "no provider")
        .with_severity(Severity::Error);
    let problems = bad.validate().unwrap_err();
    assert!(
        problems
            .iter()
            .any(|p| p.contains("actionable-diagnostics")),
        "expected the missing-remedy invariant to fire, got {problems:?}"
    );
}

#[test]
fn evidence_requiring_codes_are_rejected_without_it() {
    let missing = Diagnostic::new(
        DiagnosticCode::GapNoK8sDnsResolver,
        "endpoints are pinned statically",
    );
    let problems = missing.validate().unwrap_err();
    assert!(
        problems.iter().any(|p| p.contains("evidence-cited")),
        "expected the missing-evidence invariant to fire, got {problems:?}"
    );

    let cited = missing.with_evidence("libs/toolkit/src/discovery.rs:117");
    assert!(cited.validate().is_ok());
}

#[test]
fn default_severity_comes_from_the_code() {
    assert_eq!(
        DiagnosticCode::BindingCuttableIfDeclared.default_severity(),
        Severity::Info,
        "the severable-if-declared report is a work list, not a problem"
    );
    assert_eq!(
        DiagnosticCode::ClusterProcessLocalInMultiProcess.default_severity(),
        Severity::Error,
        "a process-local coordination backend across processes is a correctness bug"
    );
    assert_eq!(
        DiagnosticCode::GapProfileNotRuntimeType.default_severity(),
        Severity::Hint
    );
    assert_eq!(
        Diagnostic::new(DiagnosticCode::GdlParse, "boom").severity,
        Severity::Error
    );
}

#[test]
fn severity_orders_by_urgency() {
    assert!(Severity::Error > Severity::Warning);
    assert!(Severity::Warning > Severity::Info);
    assert!(Severity::Info > Severity::Hint);
}

#[test]
fn collections_sort_canonically_and_drop_duplicates() {
    // Emission order must not leak into output (`cpt-gearbox-nfr-determinism`),
    // and the same structural fact is often reached from several directions.
    let dup = || {
        Diagnostic::new(
            DiagnosticCode::BindingForcedLocal,
            "binding is local because `api-contracts` is co-located",
        )
        .with_evidence("libs/toolkit/src/discovery.rs:157")
    };

    let mut set = Diagnostics::new();
    set.push(Diagnostic::new(DiagnosticCode::GapRoles, "roles ignored").with_evidence("x:1"));
    set.push(dup());
    set.push(Diagnostic::new(DiagnosticCode::GdlParse, "bad syntax"));
    set.push(dup());
    set.finish();

    let codes: Vec<&str> = set.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(
        codes,
        ["GBX0101", "GBX0407", "GBX0601"],
        "expected code order and one deduplicated entry"
    );
    assert!(set.has_errors(), "GBX0101 is an error");
    assert_eq!(set.max_severity(), Some(Severity::Error));
    assert_eq!(set.errors().count(), 1);
}

#[test]
fn sorting_is_stable_regardless_of_insertion_order() {
    let make = || {
        vec![
            Diagnostic::new(DiagnosticCode::GdlParse, "b"),
            Diagnostic::new(DiagnosticCode::GdlParse, "a"),
            Diagnostic::new(DiagnosticCode::TopologyUnknownGear, "c")
                .with_help("declare it")
                .with_severity(Severity::Error),
        ]
    };

    let mut forward: Diagnostics = make().into_iter().collect();
    let mut backward: Diagnostics = make().into_iter().rev().collect();
    forward.finish();
    backward.finish();
    assert_eq!(forward, backward);
}

#[test]
fn locations_use_zero_based_lsp_semantics() {
    let loc = Location::new(
        "file:///repo/gears/payments-audit/payments-audit/gear.gdl",
        Range::new(
            gearbox_ir::Position::new(0, 0),
            gearbox_ir::Position::new(0, 4),
        ),
    );
    let json = serde_json::to_value(&loc).unwrap();
    assert_eq!(json["range"]["start"]["line"], 0);
    assert_eq!(json["range"]["end"]["character"], 4);

    let whole = Location::file("file:///repo/product.gdl");
    assert_eq!(whole.range, Range::whole_file());
}

#[test]
fn optional_fields_are_omitted_when_absent() {
    // The lock and the wire format are both read by humans; empty keys are noise.
    let bare = Diagnostic::new(DiagnosticCode::ClusterAutoSelected, "chose `postgres`");
    let json = serde_json::to_value(&bare).unwrap();
    // Key order in a JSON object carries no meaning; the point is that the
    // absent optional fields produce no keys at all.
    let keys: BTreeSet<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from(["code", "severity", "message"]),
        "absent optional fields must not appear as null keys"
    );

    let full = bare
        .at(Location::file("file:///p.gdl"))
        .with_related(RelatedLocation::new(
            Location::file("file:///q.gdl"),
            "required here",
        ))
        .with_help("pin it explicitly")
        .with_evidence("gears/system/cluster/cluster/src/gear.rs:47");
    let round: Diagnostic = serde_json::from_str(&serde_json::to_string(&full).unwrap()).unwrap();
    assert_eq!(round, full);
}
