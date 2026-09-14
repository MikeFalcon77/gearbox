// Carries the key from Studio's setting to the model that needs it.
//
// **Why a mirror and not a call.** The obvious implementation is to inject
// `AnthropicLanguageModelsManager` and call `setApiKey`. That does not work:
// `setApiKey` assigns a private field, while a model's `ready` status was fixed
// when it was registered and is recomputed only inside
// `createOrUpdateLanguageModels`. Making the models ready therefore means
// re-registering them, which means restating `createAnthropicModelDescription`
// -- its id shape, `apiKey: true`, streaming, caching, `maxRetries` and two
// compaction defaults -- in this repository. That is a second place for facts
// that belong to Theia, and the kind of copy that is correct on the day it is
// written and wrong after the next upgrade.
//
// So this writes the value to the preference Theia already watches, and
// `AnthropicFrontendApplicationContribution` does `setApiKey` + `updateAllModels`
// itself. Our schema owns the setting; its owner owns the wiring.
//
// **Session scope, so the mirror is not a second copy on disk.**
// `PreferenceScope.Session` is in-memory and never persisted, so
// `~/.theia/settings.json` ends up holding `gearbox.ai.apiKey` and not a
// duplicate under Theia's name. Two persisted copies of one secret would be one
// too many, and the pair would drift the first time somebody edited the file.
//
// **Applied at `ready`, not at `onStart`.** Both this contribution and
// Anthropic's register their work inside `preferenceService.ready.then(...)`, and
// which callback runs first is binding order -- so writing during `onStart` can
// land before the listener that reacts to it exists, leaving a key that is set
// and a model that is not ready. Waiting for the application state removes the
// race rather than betting on it.

import { inject, injectable } from "@theia/core/shared/inversify";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import { PreferenceScope, PreferenceService } from "@theia/core/lib/common/preferences";
import { API_KEY_PREF } from "@theia/ai-anthropic/lib/common/anthropic-preferences";

import { GEARBOX_API_KEY } from "../../common/gearbox-preferences";

@injectable()
export class ApiKeyService implements FrontendApplicationContribution {
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(FrontendApplicationStateService) protected readonly appState!: FrontendApplicationStateService;

  onStart(): void {
    void this.appState.reachedState("ready").then(async () => {
      await this.preferences.ready;
      await this.mirror();
      this.preferences.onPreferenceChanged((event) => {
        if (event.preferenceName === GEARBOX_API_KEY) void this.mirror();
      });
    });
  }

  /**
   * Put Studio's key where the Anthropic provider looks for it.
   *
   * An empty setting mirrors `undefined` rather than `""`: the backend reads
   * `this._apiKey ?? process.env.ANTHROPIC_API_KEY`, and an empty string is a
   * value, so it would shadow the environment variable with nothing. Clearing
   * the field has to mean "fall back", which is what the setting's own
   * description promises.
   */
  protected async mirror(): Promise<void> {
    const key = this.preferences.get<string>(GEARBOX_API_KEY, "").trim();
    const wanted = key === "" ? undefined : key;

    // **Write only on a difference.** Setting the preference is not free: Theia's
    // listener answers it with `updateAllModels()`, which re-registers every
    // model, and registration asks Anthropic's `/v1/models` for metadata. Writing
    // unconditionally at every page load therefore added a network round trip per
    // load on top of the one Anthropic's own contribution already makes -- which
    // is the kind of cost that shows up as an unrelated test timing out rather
    // than as anything pointing here.
    if (this.preferences.get<string | undefined>(API_KEY_PREF, undefined) === wanted) return;

    await this.preferences.set(API_KEY_PREF, wanted, PreferenceScope.Session);
  }
}
