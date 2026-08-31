// Close, once, the panels this application no longer has.
//
// Suppressing a menu entry and a command does not remove a panel that is already
// **in a saved layout**. `Type Hierarchy` and a `zsh` terminal kept coming back at
// the bottom of the shell after the shell stopped offering either -- Theia's
// `ShellLayoutRestorer` faithfully restores what was there before the rules
// changed, which is correct of it and wrong for the reader.
//
// So the rules changing needs a migration, and a migration has to run **once**.
// Closing these on every start would be a different bug: a terminal a person
// deliberately opened would vanish on reload, which is worse than one they did not
// ask for staying. The version below is what makes it once; bump it when the set
// of panels the application has changes again.
//
// Deliberately not `ApplicationShellLayoutMigration`, Theia's own hook for this:
// that one is keyed to the layout *schema* version and exists for rewriting
// serialised layout data. Nothing about the schema changed -- the application's
// inventory did -- so this closes widgets through the shell instead of rewriting
// a blob, which is both smaller and legible in a stack trace.

import { ApplicationShell, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import { StorageService } from "@theia/core/lib/browser/storage-service";
import { inject, injectable } from "@theia/core/shared/inversify";

/**
 * Widget id prefixes that no longer belong to this application.
 *
 * Prefixes because ids are generated: a terminal is `terminal-0`, `terminal-1`.
 * The families match `ShellPolicy.FORBIDDEN_COMMAND_PREFIXES` in intent, but not
 * in spelling -- a widget id and a command id are different namespaces, and
 * assuming they agreed is how the camelCase mistake in that list happened.
 */
export const CLOSED_ON_MIGRATION: readonly string[] = [
  "typehierarchy",
  "callhierarchy",
  "outline-view",
  "notebook",
  "timeline",
  "bulk-edit",
  "debug",
  "test-",
  "testing",
  // The two panels the Inspector replaced. Their widget factories are gone, so a
  // restored layout that still names them logs a construction failure and leaves
  // an empty tab -- which is exactly the shape of thing this migration exists to
  // remove. Version 2 is what makes the sweep run again for a person who already
  // ran version 1.
  "gearbox.detail",
  "gearbox.explain",
  // **No `terminal-` here, and that was learned the hard way.** Closing the boot
  // terminal broke the capability: `widget.close()` disposes the widget while
  // `WidgetManager` keeps its entry under the same id, so the next
  // `Terminal: Create New Terminal` returned the disposed instance and nothing
  // appeared -- by command and by keybinding alike, with no error. A terminal that
  // should not be open at startup is handled where it is opened, by
  // `HiddenTerminal.initializeLayout(): NOOP`, which is the mechanism ADR-0011
  // already names for Debug and Test.
];

const MIGRATION_KEY = "gearbox.layoutMigration";

/** Bump when `CLOSED_ON_MIGRATION` changes, so the sweep runs again -- once. */
const MIGRATION_VERSION = 2;

@injectable()
export class LayoutMigration implements FrontendApplicationContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(StorageService) protected readonly storage!: StorageService;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;

  onStart(): void {
    // After `ready`, because the restorer has to have restored before there is
    // anything to close. `onStart` alone runs while the shell is still being
    // assembled, and closing a widget that has not been attached yet does nothing
    // at all -- silently, which is the worst version of not working.
    void this.appState.reachedState("ready").then(() => this.migrate());
  }

  protected async migrate(): Promise<void> {
    const done = await this.storage.getData<number>(MIGRATION_KEY);
    if (done !== undefined && done >= MIGRATION_VERSION) {
      return;
    }

    const closed: string[] = [];
    for (const widget of this.shell.widgets) {
      if (CLOSED_ON_MIGRATION.some((prefix) => widget.id.startsWith(prefix))) {
        widget.close();
        closed.push(widget.id);
      }
    }
    await this.storage.setData(MIGRATION_KEY, MIGRATION_VERSION);

    if (closed.length > 0) {
      // Logged rather than silent: a panel disappearing on one particular start
      // is the kind of thing a person reasonably wants an explanation for, and
      // this is the only record that it was deliberate.
      // eslint-disable-next-line no-console
      console.info(
        `Gearbox: closed ${closed.join(", ")} -- panels this application no longer offers. ` +
          `This runs once per layout migration.`,
      );
    }
  }
}
