// A settings field that does not show what it holds.
//
// Theia's settings editor renders every `type: "string"` preference through
// `PreferenceStringInputRenderer`, which hardcodes `interactable.type = "text"`.
// There is no schema flag for a masked field -- a grep for `password`, `masked`
// and `secret` across `@theia/preferences` and core's preference code returns
// nothing -- but there *is* a renderer registry, and the winner is whichever
// creator returns the highest `canHandle` score.
//
// So this is the string renderer with one line changed, claimed at a score above
// the built-ins (string scores 2, enum 3, the file picker 5).
//
// **Keyed on the schema flag, not on a preference id.** `typeDetails` is the
// schema's documented "metadata intended for custom renderers"; a property that
// carries `gearboxSecret` gets masked without this file being edited, which is
// the difference between a mechanism and a special case.
//
// **Masking is not secrecy, and the preference's own description says so.** The
// value is in `~/.theia/settings.json` in clear text either way. What this
// prevents is a key standing in a screenshot, a screen share, or the conformance
// suite's failure traces -- which is worth having, and is not the same claim.

import { injectable, interfaces } from "@theia/core/shared/inversify";
import { PreferenceStringInputRenderer } from "@theia/preferences/lib/browser/views/components/preference-string-input";
import { PreferenceLeafNodeRendererContribution } from "@theia/preferences/lib/browser/views/components/preference-node-renderer-creator";
import type { PreferenceNodeRenderer } from "@theia/preferences/lib/browser/views/components/preference-node-renderer";
import type { Preference } from "@theia/preferences/lib/browser/util/preference-types";

import type { GearboxSecretDetail } from "../../common/gearbox-preferences";

/** Whether a schema property asked to be rendered as a secret. */
export function isSecretPreference(node: Preference.LeafNode): boolean {
  const details: unknown = node.preference.data.typeDetails;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as Partial<GearboxSecretDetail>).gearboxSecret === true
  );
}

@injectable()
export class SecretPreferenceRenderer extends PreferenceStringInputRenderer {
  protected override createInteractable(parent: HTMLElement): void {
    super.createInteractable(parent);
    // After `super`, not instead of it: everything else the base class wires --
    // the debounce, the blur handler, the modification marker -- is behaviour we
    // want unchanged, and re-creating the element here would drop it.
    this.interactable.type = "password";
    this.interactable.autocomplete = "off";
    this.interactable.setAttribute("data-gearbox-secret", "true");
  }
}

@injectable()
export class SecretPreferenceRendererContribution extends PreferenceLeafNodeRendererContribution {
  static readonly ID = "gearbox-secret-renderer";
  readonly id = SecretPreferenceRendererContribution.ID;

  canHandleLeafNode(node: Preference.LeafNode): number {
    // Above the file picker's 5, which is the highest built-in.
    return isSecretPreference(node) ? 10 : 0;
  }

  createLeafNodeRenderer(container: interfaces.Container): PreferenceNodeRenderer {
    return container.get(SecretPreferenceRenderer);
  }
}
