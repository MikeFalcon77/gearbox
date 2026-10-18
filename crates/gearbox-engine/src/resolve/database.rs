//! Resolve the selected profile's external database without I/O or env expansion.
use super::closure::Closure;
use gearbox_ir::{
    Catalogue, DeploymentProfileDecl, Diagnostic, DiagnosticCode, Diagnostics, Location,
    PostgresDatabase, RuntimeCap,
};
use std::collections::BTreeSet;

pub fn resolve(
    catalogue: &Catalogue,
    closure: &Closure,
    profile: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Option<PostgresDatabase> {
    let gears: BTreeSet<_> = closure
        .members
        .keys()
        .filter(|id| {
            catalogue
                .gears
                .get(*id)
                .is_some_and(|gear| gear.runtime_caps.contains(&RuntimeCap::Db))
        })
        .cloned()
        .collect();
    let Some(mut db) = profile.database().cloned() else {
        for gear in gears {
            report(
                profile,
                uri,
                diagnostics,
                format!(
                    "gear `{gear}` needs a database, but profile `{}` declares none",
                    profile.id()
                ),
            );
        }
        return None;
    };
    if let Err(reason) = db.validate() {
        report(profile, uri, diagnostics, reason);
    }
    if matches!(profile, DeploymentProfileDecl::Kubernetes { .. }) && db.existing_secret.is_none() {
        report(
            profile,
            uri,
            diagnostics,
            "Kubernetes postgres requires existing_secret containing the password environment key"
                .to_owned(),
        );
    }
    for gear in db.database_names.keys() {
        if !gears.contains(gear) {
            report(
                profile,
                uri,
                diagnostics,
                format!(
                    "database_names entry `{gear}` is not a selected database gear in profile `{}`",
                    profile.id()
                ),
            );
        }
    }
    for gear in gears {
        let name = db
            .database_names
            .entry(gear.clone())
            .or_insert_with(|| gear.as_str().replace('-', "_"));
        if let Err(reason) = PostgresDatabase::validate_name(name) {
            report(profile, uri, diagnostics, reason);
        }
    }
    if let Err(reason) = db.validate() {
        report(profile, uri, diagnostics, reason);
    }
    Some(db)
}

fn report(
    profile: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
    message: String,
) {
    diagnostics.push(Diagnostic::error(DiagnosticCode::TopologyDbWithoutDatabase, message,
        r#"configure database = postgres(host = ..., user = ..., password = "${GEARS_PG_PASSWORD}") on this profile; create the server and each named database before startup"#)
        .at(Location::or_file(profile.declared_at(), uri)));
}
