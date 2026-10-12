import { isAbsoluteFilePath } from "#renderer/components/file-preview";

import { isRelativePath } from "../data/search";

/** Guest-side workspace mount; the checkout root is its host path. */
const GUEST_PREFIX = "/workspace";

/**
 * The path a preview tab stores for what the agent or user named. Inside the
 * checkout it is root-relative; guest `/workspace/...` paths map onto the host
 * root first; any other absolute file stays absolute (the viewer reads it
 * under its own directory, see `containmentRootFor`). `null` is a path no
 * viewer should touch (empty, or relative with `..`).
 */
export const previewTargetPath = (
  raw: string,
  root: string | null
): string | null => {
  let path = raw;
  if (root && (path === GUEST_PREFIX || path.startsWith(`${GUEST_PREFIX}/`)))
    path = `${root}${path.slice(GUEST_PREFIX.length)}`;
  if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  if (isRelativePath(path)) return path;
  if (isAbsoluteFilePath(path) && !path.split(/[\\/]/).includes(".."))
    return path;
  return null;
};

/** Whether a tab path is absolute (outside the checkout) rather than root-relative. */
export const isAbsolutePreviewPath = (path: string): boolean =>
  !isRelativePath(path) && isAbsoluteFilePath(path);
