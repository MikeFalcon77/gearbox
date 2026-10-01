// A "New Folder" button in Theia's file dialogs.
//
// **Why it is needed.** The browser build has no native dialog, and Theia's own
// (`@theia/filesystem` 1.75, `file-dialog.js`) offers back, forward, home, up
// and a location list -- nothing that makes a folder. `file.newFolder` exists,
// but in the Explorer, not in the dialog. So every place Studio asks for a
// folder -- New Product, Create Gear, Generate's output -- could only name a new
// one by typing its path.
//
// **Why a subclass behind the factory.** Theia builds each dialog in a child
// container from `OpenFileDialogFactory` / `SaveFileDialogFactory`
// (`workspace-frontend-module.js`), and `init()` is where it lays out the
// navigation panel. Rebinding the factories to bind these subclasses in that
// child container adds the button to every dialog without touching a caller;
// the button goes right after "up", where a person looking for it looks.

import {
  SingleTextInputDialog,
  SingleTextInputDialogProps,
  codiconArray,
  createIconButton,
} from "@theia/core/lib/browser";
import { SelectableTreeNode } from "@theia/core/lib/browser/tree/tree-selection";
import { inject, injectable } from "@theia/core/shared/inversify";
import { OpenFileDialog, SaveFileDialog } from "@theia/filesystem/lib/browser/file-dialog/file-dialog";
import { FileService } from "@theia/filesystem/lib/browser/file-service";

import type { FileDialogModel } from "@theia/filesystem/lib/browser/file-dialog/file-dialog-model";

/** What the button needs of a dialog: where it is, and a way to move. */
interface HasModel {
  readonly model: FileDialogModel;
}

/**
 * Why `name` cannot be a folder name here, or `""` when it can.
 *
 * Empty is not refused *here*: the prompt validates as it opens, and a red
 * "give it a name" before anyone has typed reads as a mistake already made.
 * An empty answer is simply not a folder, and `createFolder` returns on it.
 */
export function folderNameRefusal(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  if (trimmed === "." || trimmed === "..") return "That name refers to a folder that already exists.";
  if (/[/\\]/.test(trimmed)) return "A folder name cannot contain / or \\.";
  return "";
}

/**
 * Put the button after "up" and make it create a folder in the current location.
 *
 * Shared by the open and the save dialog, which have different bases and the
 * same navigation panel.
 */
function addNewFolderButton(dialog: HasModel, up: HTMLElement, files: FileService): void {
  const button = createIconButton(...codiconArray("new-folder", true));
  button.title = "New Folder";
  // Theia places every icon in this panel absolutely, each with its own
  // `left`; the class gives this one the next slot (see `style/index.css`).
  button.classList.add("gbx-NavigationNewFolder");
  button.setAttribute("data-file-dialog-new-folder", "true");

  up.insertAdjacentElement("afterend", button);
  button.addEventListener("click", () => void createFolder(dialog, files));
}

async function createFolder(dialog: HasModel, files: FileService): Promise<void> {
  const parent = dialog.model.location;
  if (parent === undefined) return;
  const name = await new FolderNameDialog({
    title: "New Folder",
    placeholder: "folder name",
    confirmButtonLabel: "Create",
    validate: (input) => folderNameRefusal(input),
  }).open();
  if (name === undefined || name.trim() === "") return;
  const target = parent.resolve(name.trim());
  if (await files.exists(target)) {
    // Not an error: the person wanted to be in that folder, and now is.
    dialog.model.location = target;
    return;
  }
  await files.createFolder(target);
  dialog.model.location = target;
  // Into the new folder, and selected, so Open takes it as the answer rather
  // than an empty selection.
  const selectRoot = dialog.model.onChanged(() => {
    const root = dialog.model.root;
    if (root !== undefined && root.id !== undefined && SelectableTreeNode.is(root)) {
      dialog.model.selectNode(root);
      selectRoot.dispose();
    }
  });
}

/**
 * The name prompt, with a Cancel beside Create.
 *
 * `SingleTextInputDialog` appends only its accept button, so the one way out
 * was the title bar's X -- inside a dialog that is itself on top of another.
 */
class FolderNameDialog extends SingleTextInputDialog {
  constructor(props: SingleTextInputDialogProps) {
    super(props);
    const cancel = this.appendCloseButton("Cancel");
    // Cancel before Create, the order every other Theia dialog uses.
    if (this.acceptButton !== undefined) {
      this.controlPanel.insertBefore(cancel, this.acceptButton);
    }
  }
}

@injectable()
export class NewFolderOpenFileDialog extends OpenFileDialog {
  @inject(FileService) protected readonly files!: FileService;

  override init(): void {
    super.init();
    addNewFolderButton(this, this.up, this.files);
  }
}

@injectable()
export class NewFolderSaveFileDialog extends SaveFileDialog {
  @inject(FileService) protected readonly files!: FileService;

  override init(): void {
    super.init();
    addNewFolderButton(this, this.up, this.files);
  }
}
