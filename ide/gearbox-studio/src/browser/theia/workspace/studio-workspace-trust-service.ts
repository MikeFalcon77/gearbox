// Trust does not depend on a file Theia wrote to its own config directory.
//
// The bug this fixes is subtle and completely blocking. `WorkspaceTrustService`
// requires *every* workspace URI to be trusted, and `getWorkspaceUris()` includes
// the workspace file itself whenever `WorkspaceService.saved` is true --
// which is `!!workspace && !workspace.isDirectory`, so it is true for an
// **untitled** multi-root workspace too. Studio opens a multi-root workspace, so
// Theia generates `~/.theia/workspaces/Untitled-NN.theia-workspace`, and that
// path is under nobody's trusted folder. The result is a modal trust dialog over
// the whole application on every start, which no amount of
// `security.workspace.trust.trustedFolders` can dismiss: the folders are trusted
// and the generated file is not.
//
// Requiring trust for it is meaningless. It is not content anyone authored; it is
// Theia's own bookkeeping in Theia's own config directory, and anything able to
// write there can already rewrite `settings.json`. So it is dropped from the set,
// and trust once again depends on the folders -- where `DomainWorkspace` has put
// Studio's own roots, and where any other folder still prompts.
//
// The alternative was `security.workspace.trust.enabled: false`, and it is worse:
// it would trust every folder anyone ever opens, in an application that now runs
// third-party extension code from the plugin host.

import { URI } from "@theia/core/lib/common/uri";
import { WorkspaceTrustService } from "@theia/workspace/lib/browser/workspace-trust-service";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class StudioWorkspaceTrustService extends WorkspaceTrustService {
  protected override getWorkspaceUris(): URI[] {
    const workspace = this.workspaceService.workspace;
    const uris = super.getWorkspaceUris();
    if (workspace === undefined) {
      return uris;
    }
    // `configDirUri` is left out deliberately: passing it would make this an
    // async call inside a sync override, and the narrower check -- a workspace
    // file whose name starts with `Untitled` -- already only matches files Theia
    // generates for itself.
    if (!this.untitledWorkspaceService.isUntitledWorkspace(workspace.resource)) {
      return uris;
    }
    return uris.filter((uri) => !uri.isEqual(workspace.resource));
  }
}
