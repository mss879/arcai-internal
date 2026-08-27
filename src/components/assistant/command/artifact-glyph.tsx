"use client";

/**
 * An artifact's icon, as a component.
 *
 * `artifactIcon()` returns a component *reference*, and assigning one to a
 * capitalised local inside a render body reads to the React compiler as
 * building a new component type on every render — which, if it were true,
 * would remount the subtree each time. Doing the lookup inside a component
 * defined once at module scope says what is actually meant: the same handful
 * of Lucide icons, chosen per artifact.
 */

import * as React from "react";

import { artifactIcon } from "@/components/assistant/preview/artifact-format";
import type { Artifact } from "@/lib/assistant-artifacts";

export function ArtifactGlyph({
  artifact,
  className,
}: {
  artifact: Artifact;
  className?: string;
}): React.ReactElement {
  // `createElement` rather than binding the result to a capitalised local:
  // the lookup returns an existing icon, and naming it `Icon` in a render
  // body is indistinguishable — to the compiler — from defining a new
  // component type on every pass.
  return React.createElement(artifactIcon(artifact), { className });
}
