// Which plugin fills which point, in one place.
//
// A host declares `extension_points` and a plugin declares the one it `fills`;
// both are projected from the plugin-API trait an SDK crate declares, and the
// join key is the pair `(sdk_lib, trait_ident)` -- never a derived short name,
// because `to_kebab_case("AuthNResolverPluginClient")` splits `AuthN` wrongly
// and GBX0206 exists to catch exactly that.
//
// **One key function, for the reason `gearbox_ir::binding_key` exists.** The
// graph builder used to format a binding's node key inline and a diagnostic
// naming the same node would have formatted it again; two format strings for one
// convention is how a client ends up asking about something that is not there,
// silently. The spelling here matches `ExtensionPointDecl::qualified()`
// (`crates/gearbox-ir/src/catalogue.rs`), so a UI label and a diagnostic name the
// same point the same way.

import type { ExtensionPointDecl } from "./generated/ExtensionPointDecl";
import type { GearDescriptor } from "./generated/GearDescriptor";

/** How a point is spelled: `authn_resolver_sdk::AuthNResolverPluginClient`. */
export function pointKey(point: ExtensionPointDecl): string {
  return `${point.sdk_lib}::${point.trait_ident}`;
}

/** The points a gear expects an implementation for. */
export function pointsOf(host: GearDescriptor): readonly ExtensionPointDecl[] {
  return host.extension_points ?? [];
}

/**
 * Whether `plugin` fills one of `host`'s declared points.
 *
 * This is the predicate the Add Gear panel was missing. It offered every gear in
 * the catalogue that fills *any* point, so `types-registry` -- whose own panel
 * said "Extension points: none declared." -- could be given an authentication
 * plugin, and the closure preview then reported `oidc-authn-plugin` as a
 * "plugin of types-registry". The engine did not refuse it either: its check asks
 * whether *some* selected gear expects the point, not whether the host it was
 * listed under does.
 */
export function fillsPointOf(plugin: GearDescriptor, host: GearDescriptor): boolean {
  const fills = plugin.fills ?? undefined;
  if (fills === undefined) return false;
  const wanted = pointKey(fills.point);
  return pointsOf(host).some((point) => pointKey(point) === wanted);
}

/** The plugins in `rows` that are applicable to `host`, by point, id-sorted. */
export function pluginsByPoint(
  host: GearDescriptor,
  rows: readonly GearDescriptor[],
): { point: ExtensionPointDecl; plugins: GearDescriptor[] }[] {
  return pointsOf(host).map((point) => ({
    point,
    plugins: rows
      .filter((row) => {
        const fills = row.fills ?? undefined;
        return fills !== undefined && pointKey(fills.point) === pointKey(point);
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
}
