// What the chat may do to a product, and how little of it is new.
//
// The tool does not write. It calls `ProductEditService.toggle`, the same entry
// point the catalogue's own control uses, and that method owns the policy: it
// refuses when no product is open, refuses when the description has unsaved
// changes rather than discarding them, renders the exact line it would write,
// and waits for a person to agree. So the chat gets no privilege the UI does not
// already have, and the preview stays where ADR-0010 put it -- in front of the
// write, not behind it.
//
// One tool, deliberately. The demo asks whether a product can be configured by
// asking for it in words; adding a second verb before the first one is observed
// would be guessing at which verbs matter.

import { inject, injectable } from "@theia/core/shared/inversify";
import type { ToolProvider, ToolRequest } from "@theia/ai-core";

import { ProductEditService } from "../product-edit-service";

/** The source every gear in the demo corpus is drawn from. */
const SOURCE = "gears-rust";

@injectable()
export class ProductGearTool implements ToolProvider {
  static ID = "gearbox_toggle_gear";

  @inject(ProductEditService) protected readonly edits!: ProductEditService;

  getTool(): ToolRequest {
    return {
      id: ProductGearTool.ID,
      name: ProductGearTool.ID,
      description:
        "Add a gear to the open Gearbox product, or remove it if it is already selected. " +
        "The gear is named by its kebab-case id, e.g. `tenant-resolver`. A preview of the " +
        "exact line to be written is shown to the operator, who must agree before anything " +
        "is written; if they decline, nothing changes and this says so.",
      parameters: {
        type: "object",
        properties: {
          gear: {
            type: "string",
            description: "The kebab-case gear id, as the catalogue spells it.",
          },
        },
        required: ["gear"],
      },
      handler: async (argString: string) => {
        let gear: unknown;
        try {
          gear = (JSON.parse(argString || "{}") as { gear?: unknown }).gear;
        } catch {
          return "The arguments were not valid JSON.";
        }
        if (typeof gear !== "string" || gear.trim() === "") {
          return "`gear` must be the gear's kebab-case id.";
        }

        const was = this.edits.inProduct(gear);
        const changed = await this.edits.toggle(gear, SOURCE);
        if (!changed) {
          // Refused, cancelled, or impossible -- `toggle` has already told the
          // operator which, through the message service. Saying "no change" here
          // without inventing a reason is the honest report.
          return `The product was not changed. \`${gear}\` is ${
            was ? "still selected" : "still not selected"
          }.`;
        }
        return was
          ? `Removed \`${gear}\` from the product.`
          : `Added \`${gear}\` to the product.`;
      },
    };
  }
}
