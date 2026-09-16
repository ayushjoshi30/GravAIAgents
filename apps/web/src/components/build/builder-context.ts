"use client";

import { createContext, useContext } from "react";

/**
 * The handful of operations a node card needs from the builder.
 *
 * Passed through context rather than through each node's `data` because the
 * connect-mode flag changes what every card on the canvas offers — while a
 * link is in progress every other node shows "connect here" instead of its own
 * connect control — and threading that through node data would rewrite the
 * data object of every node on every keystroke of a link.
 */
export interface Linking {
  source: string;
  /** Which branch of the source this link leaves by. Empty for a plain edge. */
  branch: string;
}

export interface BuilderApi {
  linking: Linking | null;
  /** Begin a link from `source`. Nothing is created until a target is picked. */
  startLink: (source: string, branch: string) => void;
  /** Finish the link in progress at `target`, or do nothing if it is invalid. */
  completeLink: (target: string) => void;
  cancelLink: () => void;
  removeNode: (id: string) => void;
  renameNode: (id: string, name: string) => void;
}

const FALLBACK: BuilderApi = {
  linking: null,
  startLink: () => {},
  completeLink: () => {},
  cancelLink: () => {},
  removeNode: () => {},
  renameNode: () => {},
};

export const BuilderContext = createContext<BuilderApi>(FALLBACK);

export function useBuilder(): BuilderApi {
  return useContext(BuilderContext);
}
