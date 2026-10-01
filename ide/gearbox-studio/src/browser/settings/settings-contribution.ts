// `Gearbox: Settings` — one command, and the menu entry for it, plus the
// connectivity check that belongs beside it.
//
// It opens Theia's own settings editor filtered to `gearbox`, which is the whole
// implementation: `preferences:open` takes an optional query string, and that is
// how `@theia/ai-core`'s `Show AI Settings` works. Studio contributes a section
// (`theia/preferences/gearbox-preference-layout.ts`) rather than an editor, so
// there is nothing here to render.
//
// Not a `ScopedViewContribution`, because there is no view: no widget id, no
// entry in `SCREENS`, nothing to withdraw when the context changes. A settings
// editor belongs to the installation, not to whatever product is open.

import { inject, injectable } from "@theia/core/shared/inversify";
import { CommonCommands } from "@theia/core/lib/browser";
import { CommandRegistry, MenuModelRegistry } from "@theia/core";
import type { CommandContribution, MenuContribution } from "@theia/core";
import { CommandService } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";

import { GearboxService } from "../../common/protocol";
import { summariseConnectivity } from "../ai/connectivity-report";
import { FILE_SETTINGS } from "../menus";
import { CHECK_AI_CONNECTION, SHOW_SETTINGS } from "../shell/session-command-ids";

/** The query the editor opens on. Matches the section's `settings: ["gearbox.*"]`. */
export const GEARBOX_SETTINGS_QUERY = "gearbox";

@injectable()
export class SettingsContribution implements CommandContribution, MenuContribution {
  @inject(CommandService) protected readonly commands!: CommandService;
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(MessageService) protected readonly messages!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(SHOW_SETTINGS, {
      execute: () =>
        this.commands.executeCommand(CommonCommands.OPEN_PREFERENCES.id, GEARBOX_SETTINGS_QUERY),
    });

    // Palette only, no menu entry: this answers a question somebody already has,
    // and a permanent item for a check that almost always passes is noise in a
    // menu that is otherwise about doing things.
    registry.registerCommand(CHECK_AI_CONNECTION, {
      execute: async () => {
        const check = await this.service.checkAiConnectivity();
        const summary = summariseConnectivity(check);
        // Error rather than info when it fails, because it is one: the operator
        // asked a yes/no question and the answer is no.
        if (check.ok) {
          this.messages.info(summary);
        } else {
          this.messages.error(summary);
        }
      },
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(FILE_SETTINGS, {
      commandId: SHOW_SETTINGS.id,
      label: SHOW_SETTINGS.shortTitle,
      order: "0",
    });
  }
}
