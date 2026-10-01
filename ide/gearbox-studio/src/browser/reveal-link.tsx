// One link that opens a file the engine pointed at.
//
// Extracted because two widgets need it and the reasoning is not obvious enough
// to reproduce twice. From `reveal-service.ts`: "An `<a>` with only an `onClick`
// is a div wearing a hat: no keyboard activation, no focus ring, nothing for a
// screen reader to announce, and no target in the status bar." So there is a real
// `href`, and `preventDefault` keeps the navigation inside Theia.
//
// `href` falls back to `#` when the service cannot resolve one -- the click
// handler still runs, and `RevealService` reports why it could not open rather
// than doing nothing. A link that silently does nothing is worse than one that
// says why: the first looks like the file is uninteresting, the second looks like
// a bug, and it is one.

import React from "@theia/core/shared/react";

import { RevealService } from "./reveal-service";

export interface RevealLinkProps {
  readonly reveals: RevealService;
  /** The source root the path is relative to. */
  readonly source: string;
  /** The path, relative to that root. */
  readonly target: string;
  readonly label: string;
  readonly className?: string;
  /**
   * Run before opening. The Product view uses it to point Explain at the same
   * gear, so one click answers both "show me this" and "why is it here".
   */
  readonly onActivate?: () => void;
}

export function RevealLink(props: RevealLinkProps): React.ReactElement {
  const { reveals, source, target, label, className, onActivate } = props;
  return (
    <a
      href={reveals.uriFor(source, target) ?? "#"}
      title={target}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        onActivate?.();
        void reveals.reveal(source, target);
      }}
    >
      {label}
    </a>
  );
}

/** The same link for a path the engine gave in absolute form. */
export interface RevealPathLinkProps {
  readonly reveals: RevealService;
  readonly path: string;
  readonly label: string;
  readonly className?: string;
}

export function RevealPathLink(props: RevealPathLinkProps): React.ReactElement {
  const { reveals, path, label, className } = props;
  return (
    <a
      href={reveals.uriForPath(path)}
      title={path}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void reveals.revealPath(path);
      }}
    >
      {label}
    </a>
  );
}
