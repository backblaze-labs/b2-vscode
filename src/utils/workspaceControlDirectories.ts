/**
 * Shared policy for workspace metadata/control directories.
 *
 * @module utils/workspaceControlDirectories
 */

const WORKSPACE_CONTROL_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vscode",
  ".idea",
  ".github",
  ".devcontainer",
  ".husky",
  ".circleci",
  ".gitlab",
  ".gitea",
]);

export function isWorkspaceControlDirectorySegment(segment: string): boolean {
  return WORKSPACE_CONTROL_DIRECTORY_SEGMENTS.has(segment.toLowerCase().replace(/[. ]+$/u, ""));
}
