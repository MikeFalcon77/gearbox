// Which profiles a plugin connection applies to, said as a choice rather than
// as an absence.
//
// **The model is right and the old control lied about it.** An empty scope means
// *every* profile — `gearbox_ir::intent::applies` is `scoped_to.is_empty() ||
// scoped_to.contains(profile)`, and the writer deliberately emits no argument at
// all rather than `profiles = []`, because `profiles = []` would read as "no
// profile". So the widest possible setting was reached by unchecking the last
// box, which looks exactly like switching something off. A `<small>` said so and
// was not enough: the person who found this read the hint and still had to open
// the preview to learn what had happened.
//
// So the two states are named and mutually exclusive, and the second cannot
// reach zero: the last remaining profile refuses to be unchecked, and says why,
// rather than silently meaning "all of them".

import React from "@theia/core/shared/react";

export interface ProfileScopeProps {
  /** The scope as written. Empty means every profile. */
  readonly profiles: readonly string[];
  /** Every profile the product declares, plus any this entry names. */
  readonly available: readonly string[];
  /** Which profile is being viewed, used when switching to a narrow scope. */
  readonly viewing?: string;
  /** Whether an id is a profile the product actually declares. */
  readonly declared?: (id: string) => boolean;
  readonly onChange: (profiles: string[]) => void;
  readonly legend?: string;
}

export function ProfileScope({
  profiles,
  available,
  viewing,
  declared,
  onChange,
  legend = "Profiles for this connection",
}: ProfileScopeProps): React.ReactElement {
  const all = profiles.length === 0;
  const only = profiles.length === 1;
  // Switching to a narrow scope has to start somewhere, and the profile being
  // viewed is the one the person is looking at. Falling back to the first
  // declared profile rather than to `""`: an empty string is a valid-looking id
  // that names no profile, and the old control wrote exactly that when both the
  // viewed profile and the list were absent.
  const first = viewing ?? available[0];
  return (
    <fieldset className="gbx-profile-scope" data-profile-scope={all ? "all" : "selected"}>
      <legend>{legend}</legend>
      <label>
        <input
          type="radio"
          name={`scope-${legend}`}
          checked={all}
          data-profile-scope-all
          onChange={() => onChange([])}
        />
        All profiles
      </label>
      <label>
        <input
          type="radio"
          name={`scope-${legend}`}
          checked={!all}
          data-profile-scope-selected
          disabled={first === undefined}
          onChange={() => {
            if (first !== undefined) onChange([first]);
          }}
        />
        Selected profiles
      </label>
      {!all && (
        <div className="gbx-profile-scope-list">
          {available.map((id) => {
            const on = profiles.includes(id);
            // The last one standing cannot be turned off. Reaching zero is how
            // "narrow this to one profile" silently became "apply everywhere",
            // and there is a control one line up that means that on purpose.
            const pinned = on && only;
            return (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={pinned}
                  data-profile={id}
                  title={
                    pinned
                      ? "A narrow scope needs at least one profile. Choose All profiles instead."
                      : undefined
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...profiles, id]
                        : profiles.filter((p) => p !== id),
                    )
                  }
                />
                {id}
                {declared?.(id) === false ? " (unknown profile)" : ""}
              </label>
            );
          })}
          <small>A narrow scope needs at least one profile; All profiles is the other choice.</small>
        </div>
      )}
      {all && <small>This connection applies under every profile the product declares.</small>}
    </fieldset>
  );
}
