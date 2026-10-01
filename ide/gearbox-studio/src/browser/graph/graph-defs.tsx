// The arrowhead markers every graph view points its edges with.
//
// Rendered once by the widget into a zero-height SVG rather than repeated inside
// each view's own SVG: a `url(#id)` marker reference resolves across the whole
// document, and four copies of the same four markers would mean four ids that
// have to stay in step.
//
// Separate markers per state rather than one marker and a CSS rule, because an
// SVG marker does **not** inherit the referencing path's `stroke`. A dashed red
// edge with a grey arrowhead was the first version of the contract graph.

import React from "@theia/core/shared/react";

const MARKERS: readonly { id: string; head: string }[] = [
  { id: "gbx-arrow", head: "gbx-arrow-head" },
  { id: "gbx-arrow-lit", head: "gbx-arrow-head-lit" },
  // A severed contract edge, and one the resolver reports as broken.
  { id: "gbx-arrow-cuttable", head: "gbx-arrow-head-cuttable" },
  { id: "gbx-arrow-bad", head: "gbx-arrow-head-bad" },
];

export function GraphDefs(): React.ReactElement {
  return (
    <svg className="gbx-defs" width={0} height={0} aria-hidden="true">
      <defs>
        {MARKERS.map(({ id, head }) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" className={head} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
