// Whether a path has edits in a buffer nobody has saved.
//
// One function because there were three byte-identical copies of it --
// `ProductEditService`, `ProductSessionService`, `GearSessionService` -- and a
// fourth was about to be written for the description watcher. Each was doing
// the same delicate thing: comparing a filesystem path against Monaco's URI
// spelling, which is a comparison that is wrong in a way nothing notices if the
// normalisation drifts between copies.
//
// A free function taking the model service rather than a service of its own:
// there is no state here, and a class would need binding, injecting and
// remembering.

import { URI } from "@theia/core/lib/common/uri";
import type { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";

/**
 * Whether `path` is open in an editor with unsaved changes.
 *
 * Compared by URI rather than by path string, because a model's URI is
 * normalised and a path is not -- `/a/./b` and `/a/b` are the same file and
 * different strings, and Monaco holds its models under `file:///…` besides.
 */
export function hasUnsavedEdits(models: MonacoTextModelService, path: string): boolean {
  const wanted = URI.fromFilePath(path).toString();
  return models.models.some((model) => model.uri === wanted && model.dirty);
}
