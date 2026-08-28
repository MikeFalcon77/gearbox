//! `config/<p>.yaml` -- the runtime `AppConfig` for one process.
//!
//! Built as typed Rust and serialized with `serde-saphyr`, pinned to the exact
//! version `gears-rust` deserializes with. That pin is the point: the file is
//! read back by `toolkit::bootstrap::AppConfig`, whose per-gear bag is
//! `HashMap<String, serde_json::Value>` and whose sections carry
//! `deny_unknown_fields`. A YAML dialect that merely looks right -- a different
//! quoting rule, a different treatment of an empty map -- produces a file that
//! loads on one side and is rejected on the other.
//!
//! What is written is only what the lock decided. Everything the runtime already
//! has a default for is left out, so a reader can tell a resolved fact from a
//! restated one, and so a change in a platform default reaches the generated
//! product instead of being frozen into it.

use std::collections::BTreeMap;

use gearbox_ir::{
    ClusterResolution, FileEntry, FileKind, Ownership, ProcessKind, ResolvedProcess, SpawnSpec,
};
use serde::Serialize;
use serde_json::{Map, Value};

use super::{GenerateError, GenerateInput, header, paths};

/// The gear that owns cluster configuration.
///
/// Named rather than discovered: `profiles` is a key inside *that* gear's
/// config, and no other gear reads it.
const CLUSTER_GEAR: &str = "cluster";

#[derive(Serialize)]
struct AppConfig {
    server: ServerSection,
    gears: BTreeMap<String, GearSection>,
}

#[derive(Serialize)]
struct ServerSection {
    home_dir: String,
}

#[derive(Serialize)]
struct GearSection {
    /// Present only for a gear the host spawns out of process.
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<RuntimeSection>,
    /// Always present, even when empty. `toolkit`'s `GearConfig` defaults it,
    /// but `list_gear_names` reads the *keys of the gears map*, so a gear with
    /// nothing to configure still has to appear or the composed set and the
    /// configured set stop matching -- and that match is one of the two oracles
    /// this milestone is verified by.
    config: Map<String, Value>,
}

#[derive(Serialize)]
struct RuntimeSection {
    #[serde(rename = "type")]
    kind: &'static str,
    execution: ExecutionSection,
}

#[derive(Serialize)]
struct ExecutionSection {
    executable_path: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    working_directory: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    environment: BTreeMap<String, String>,
}

/// The runtime configuration for one process.
///
/// # Errors
/// Returns [`GenerateError::Yaml`] if the configuration cannot be serialized.
pub fn app_config(
    input: &GenerateInput<'_>,
    process: &ResolvedProcess,
) -> Result<FileEntry, GenerateError> {
    let mut gears: BTreeMap<String, GearSection> = process
        .gears
        .iter()
        .map(|id| {
            (
                id.to_string(),
                GearSection {
                    runtime: None,
                    config: Map::new(),
                },
            )
        })
        .collect();

    write_endpoints(process, &mut gears);
    write_consumer_wiring(input, process, &mut gears);
    write_cluster(input, process, &mut gears);
    write_spawns(process, &mut gears);

    let config = AppConfig {
        server: ServerSection {
            // Scoped per product and profile. Two products sharing
            // `~/.cf-gears` would share every gear's SQLite file, and the
            // symptom of that is data appearing in the wrong product rather
            // than an error.
            home_dir: format!(
                "~/.cf-gears/{}/{}",
                input.lock.product.id, input.lock.product.profile
            ),
        },
        gears,
    };

    let body = serde_saphyr::to_string(&config).map_err(|source| GenerateError::Yaml {
        what: "the runtime configuration",
        source,
    })?;

    Ok(FileEntry::text(
        paths::rel(&["config", &format!("{}.yaml", process.name)])?,
        format!("{}\n{body}", header("#")),
        FileKind::Yaml,
        Ownership::Generated,
    ))
}

/// Each socket the resolver assigned, under the gear's own configuration key.
///
/// The key comes from the gear's `serves` declaration, not from a table here:
/// the REST host calls it `bind_addr` and the gRPC hub calls it `listen_addr`,
/// and the generator has to write whichever one the gear actually reads.
fn write_endpoints(process: &ResolvedProcess, gears: &mut BTreeMap<String, GearSection>) {
    for endpoint in &process.listens {
        let Some(section) = gears.get_mut(endpoint.gear.as_str()) else {
            // A `listens` entry for a gear not in the process is a resolver
            // bug. Skipping it writes no wrong key; `report_orphans` is what
            // notices the gear itself is missing.
            continue;
        };
        insert_path(
            &mut section.config,
            &endpoint.config_key,
            Value::String(endpoint.address.clone()),
        );
    }
}

/// Endpoint overrides for edges that cross a process boundary.
///
/// Written into the *consumer's* configuration, because that is where
/// `StaticEndpointResolver` reads them. A co-located binding gets nothing at
/// all -- absence is what makes the client hub's local lookup win, and writing
/// a loopback URL for it would be a configuration key that silently overrides a
/// decision the lock says was made at link time.
fn write_consumer_wiring(
    input: &GenerateInput<'_>,
    process: &ResolvedProcess,
    gears: &mut BTreeMap<String, GearSection>,
) {
    for binding in &input.lock.bindings {
        if binding.consumer_process != process.name || !binding.is_remote() {
            continue;
        }
        let Some(endpoint) = binding.endpoint.as_ref() else {
            continue;
        };
        let Some(section) = gears.get_mut(binding.consumer.as_str()) else {
            continue;
        };
        let wiring = section
            .config
            .entry("consumer_wiring".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = wiring.as_object_mut() {
            map.insert(
                binding.provider.to_string(),
                Value::String(endpoint.clone()),
            );
        }
    }
}

/// The cluster gear's per-scope backend bindings.
///
/// `leader_election` and `lock` are deliberately **not** written when the lock
/// resolved them to the SDK's compare-and-swap default: omitting the key is
/// what engages that default. Writing `leader_election: { provider: cache }`
/// would name a provider that is not registered and fail startup, so the
/// omission is the instruction, not the absence of one.
fn write_cluster(
    input: &GenerateInput<'_>,
    process: &ResolvedProcess,
    gears: &mut BTreeMap<String, GearSection>,
) {
    let Some(section) = gears.get_mut(CLUSTER_GEAR) else {
        return;
    };

    let mut profiles: Map<String, Value> = Map::new();
    for binding in &input.lock.cluster {
        // Only the primitives this process's gears actually asked for.
        if !binding.requesters.iter().any(|gear| process.contains(gear)) {
            continue;
        }
        let ClusterResolution::Provider { name } = &binding.resolved else {
            continue;
        };

        let mut backend = Map::new();
        backend.insert("provider".to_owned(), Value::String(name.clone()));
        for (key, value) in &binding.options {
            backend.insert(key.clone(), value.clone());
        }
        if let Some(secret) = &binding.secret_ref {
            backend.insert("secret_ref".to_owned(), Value::String(secret.clone()));
        }

        let scope = profiles
            .entry(binding.scope.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = scope.as_object_mut() {
            map.insert(binding.primitive.slug().to_owned(), Value::Object(backend));
        }
    }

    if !profiles.is_empty() {
        section
            .config
            .insert("profiles".to_owned(), Value::Object(profiles));
    }
}

/// Out-of-process execution for each worker this host starts.
///
/// The `runtime` key must exist for every spawned gear, and it is the key
/// rather than its contents that matters: the host builds its spawn table by
/// iterating the configured gears and reading each one's runtime kind, so a
/// worker with no entry is a worker nobody starts.
fn write_spawns(process: &ResolvedProcess, gears: &mut BTreeMap<String, GearSection>) {
    if !matches!(process.kind, ProcessKind::Host) {
        return;
    }
    for spawn in &process.spawns {
        let Some(section) = gears.get_mut(spawn.gear.as_str()) else {
            continue;
        };
        section.runtime = Some(RuntimeSection {
            kind: "oop",
            execution: execution(spawn),
        });
    }
}

fn execution(spawn: &SpawnSpec) -> ExecutionSection {
    ExecutionSection {
        executable_path: spawn.executable_path.clone(),
        args: spawn.args.clone(),
        working_directory: spawn.working_directory.clone(),
        environment: spawn.environment.clone(),
    }
}

/// Insert `value` at a possibly dotted configuration key.
///
/// `serves` records the key a gear reads, and nothing stops that key from
/// naming a nested field. Splitting on `.` here means a gear that declares
/// `health.bind_addr` gets a nested map rather than a literal key with a dot in
/// it, which the gear's `deny_unknown_fields` would reject.
fn insert_path(target: &mut Map<String, Value>, key: &str, value: Value) {
    let mut segments = key.split('.').peekable();
    let mut cursor = target;
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            cursor.insert(segment.to_owned(), value);
            return;
        }
        let next = cursor
            .entry(segment.to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        // A non-map already sitting at an intermediate segment means two
        // endpoints disagree about the shape of one key. Replacing it would
        // hide that; leaving it alone drops this endpoint, which the missing
        // bind address makes loud at startup.
        match next.as_object_mut() {
            Some(map) => cursor = map,
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dotted_key_becomes_a_nested_map() {
        let mut target = Map::new();
        insert_path(&mut target, "health.bind_addr", Value::String("x".into()));
        let health = target.get("health").and_then(Value::as_object);
        assert_eq!(
            health
                .and_then(|m| m.get("bind_addr"))
                .and_then(Value::as_str),
            Some("x")
        );
    }

    #[test]
    fn a_flat_key_stays_flat() {
        let mut target = Map::new();
        insert_path(&mut target, "bind_addr", Value::String("x".into()));
        assert_eq!(target.get("bind_addr").and_then(Value::as_str), Some("x"));
    }
}
