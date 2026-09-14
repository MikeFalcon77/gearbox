// The application graph: what ends up in which binary.
//
// Boxes, not a node-link drawing, and a gear that two closures reach is drawn
// **inside both boxes**. That repetition is the entire content of the view. Every
// other way of showing a topology -- a partition, a tree, one chip per gear with
// an owner label -- implies that a gear belongs to one application, and the
// resolver's central finding is that it does not: `deps` is link-time, so an
// application is the closure of its anchor and closures overlap.
// `ResolvedApplication.gears` says so in its own doc comment: "**May overlap other
// applications.** A gear reached by two
// closures is linked into both binaries; that is a consequence of co-location
// being a closure rather than a partition, not a mistake."
//
// Where there is no overlap, the view says so in words instead of leaving the
// reader to infer it from the absence of a repeat. **On this corpus that is every
// profile**, and the reason is worth knowing before reading the drawing: `dev`
// resolves to a single application of eight gears, and `prod` resolves to three --
// six, one and one -- whose extra anchors, `api-contracts` and
// `api-contracts-consumer`, declare no `deps`. Their closures are singletons, so
// there is nothing to share and this split happens to be a partition. That is a property of the
// corpus, not of the resolver, and `prd-product.spec.ts` reports the matching
// claim as "not observed" for exactly this reason rather than claiming a pass.
//
// So the empty-overlap wording is not a corner case to be tidied away later: it is
// what this view says today, and it has to say it without implying that a
// partition is what the model produces.

import React from "@theia/core/shared/react";

import type { ResolvedApplication } from "../../../common/generated/ResolvedApplication";

export interface ApplicationsViewProps {
  readonly applications: readonly ResolvedApplication[];
  readonly profile: string | undefined;
}

export function ApplicationsView({ applications, profile }: ApplicationsViewProps): React.ReactElement {
  if (applications.length === 0) {
    return (
      <div className="gbx-empty">
        This profile resolved no applications. An application comes from an
        <code> application(...)</code> entry in the description, or from the single
        host the profile implies.
      </div>
    );
  }

  const shared = sharedGears(applications);

  return (
    <>
      <div className="gbx-header">
        One box is one binary, and its gears are the co-location closure of its
        anchor
        {profile ? (
          <>
            {" "}
            in profile <code>{profile}</code>
          </>
        ) : undefined}
        .{" "}
        {shared.size === 0 ? (
          <>
            No gear appears in more than one box here, so this profile happens to
            look like a partition. That is a property of this topology, not of the
            model: a second application anchored on a gear inside an existing
            closure would put shared gears in both boxes.
          </>
        ) : (
          <>
            <strong>
              {shared.size} {shared.size === 1 ? "gear appears" : "gears appear"} in
              more than one box
            </strong>{" "}
            and {shared.size === 1 ? "is" : "are"} linked into each of those
            binaries. That is co-location being a closure rather than a partition --
            the same gear, compiled twice, on purpose.
          </>
        )}
      </div>
      <div className="gbx-binaries" data-graph="applications">
        {[...applications]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((process) => (
            <div className="gbx-binary" key={process.name} data-binary={process.name}>
              <div className="gbx-binary-head">
                <span className={`codicon codicon-${iconFor(process)}`} />
                <span className="gbx-binary-name">{process.name}</span>
                <span className="gbx-badge">{process.kind}</span>
                {process.replicas !== 1 && (
                  <span className="gbx-badge" title="replicas">
                    &times;{process.replicas}
                  </span>
                )}
              </div>
              <div className="gbx-binary-meta">
                <code>{process.bin_name}</code>
                {(process.listens ?? []).length > 0 && (
                  <span className="gbx-binary-listens">
                    {" listens on "}
                    {(process.listens ?? []).map((endpoint) => endpoint.name).join(", ")}
                  </span>
                )}
              </div>
              <div className="gbx-binary-gears">
                {[...process.gears]
                  .sort((a, b) => a.localeCompare(b))
                  .map((gear) => (
                    <span
                      key={gear}
                      className={`gbx-badge gbx-binary-gear ${
                        shared.has(gear) ? "gbx-binary-gear-shared" : ""
                      } ${gear === process.anchor ? "gbx-binary-gear-anchor" : ""}`}
                      data-gear={gear}
                      data-shared={shared.has(gear) ? "true" : "false"}
                      title={
                        gear === process.anchor
                          ? `${gear}: the anchor whose closure defines this application`
                          : shared.has(gear)
                            ? `${gear}: also linked into another binary`
                            : gear
                      }
                    >
                      {gear === process.anchor && (
                        <span className="codicon codicon-pinned" />
                      )}
                      {gear}
                    </span>
                  ))}
              </div>
            </div>
          ))}
      </div>
      {shared.size > 0 && (
        <div className="gbx-footer">
          Shared: {[...shared].sort((a, b) => a.localeCompare(b)).join(", ")}.
        </div>
      )}
    </>
  );
}

/**
 * Gears that more than one application links in.
 *
 * The classes here are `gbx-binary*` and the attribute is `data-binary`, not
 * `gbx-application*`/`data-application`: the Product tree already owns those, and the
 * Product view's own test reads `[data-application]` across the whole document. One
 * name, one meaning per document -- the same rule the catalogue toggle learned
 * when its `data-gear` swallowed a click meant for a graph node.
 */
function sharedGears(applications: readonly ResolvedApplication[]): Set<string> {
  const seen = new Map<string, number>();
  for (const process of applications) {
    // Over a de-duplicated set per application: a gear listed twice inside one
    // `gears` array would otherwise count as shared with itself, which would
    // report an overlap that does not exist.
    for (const gear of new Set(process.gears)) {
      seen.set(gear, (seen.get(gear) ?? 0) + 1);
    }
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([gear]) => gear));
}

function iconFor(process: ResolvedApplication): string {
  return process.kind === "worker" ? "server-process" : "server";
}
