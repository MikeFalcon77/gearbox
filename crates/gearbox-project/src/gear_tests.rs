//! The `#[toolkit::gear(...)]` argument list, at the parser.
//!
//! `GearArgs` had no direct test: everything that reads it came in through the
//! corpus, which exercises the arguments the corpus happens to use. These pin
//! the two that are easy to get wrong -- a `bool` argument, and the
//! fallthrough that decides what happens to one nobody has modelled yet.

use syn::parse_quote;

use super::{GearArgs, ProjectedGear};

fn parse(args: &proc_macro2::TokenStream) -> ProjectedGear {
    let attr: syn::Attribute = parse_quote!(#[toolkit::gear(#args)]);
    attr.parse_args::<GearArgs>()
        .expect("the attribute parses")
        .0
}

#[test]
fn one_per_installation_is_read_rather_than_left_unmodelled() {
    let projected = parse(&parse_quote!(
        name = "gear-orchestrator",
        capabilities = [grpc, system, rest],
        one_per_installation = true
    ));
    assert!(projected.one_per_installation);
    assert!(
        projected.unmodelled.is_empty(),
        "modelled, so it must not also be recorded as a gap: {:?}",
        projected.unmodelled
    );
}

#[test]
fn a_gear_that_says_nothing_is_not_one_per_installation() {
    // Absence is the ordinary answer, and it must not be confused with a
    // declared `false`.
    let projected = parse(&parse_quote!(name = "api-gateway", capabilities = [rest]));
    assert!(!projected.one_per_installation);

    let declared_false = parse(&parse_quote!(
        name = "api-gateway",
        one_per_installation = false
    ));
    assert!(!declared_false.one_per_installation);
}

#[test]
fn an_argument_this_parser_does_not_model_is_recorded_as_a_gap() {
    // The fallthrough's purpose, pinned. Worth knowing: `unmodelled` is
    // written here and read by nobody, so a gap is *recorded* rather than
    // surfaced -- the field's own doc claims more than the tool does.
    let projected = parse(&parse_quote!(name = "x", something_new = "value"));
    assert_eq!(projected.unmodelled, ["something_new"]);
}
