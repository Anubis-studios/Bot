/**
 * A filesystem path as the model reads it. Copied into a JSON tool call, a
 * Windows path's backslashes turn into escapes (`\notes.md` arrives as a
 * newline and `otes.md`), so the model is shown forward slashes, which Windows
 * and Node accept. Only text for the model changes; disk access stays native.
 * Imports nothing, so the renderer can use it too.
 */

/** A drive (`C:\`, `C:/`) or UNC (`\\host`) path, whatever the host is. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** The `\\?\C:\` and `\\?\UNC\` long-path prefixes. */
const LONG_PREFIX = /^\\\\[?.]\\(?:([A-Za-z]:)|UNC\\)/i;

const hostPlatform = (): string | undefined =>
  typeof process === "undefined" ? undefined : process.platform;

/**
 * `target` with forward slashes when it is a Windows path: any path on a
 * win32 host, or a drive/UNC path anywhere (the renderer has no platform).
 * POSIX paths come back unchanged.
 */
export function modelPath(
  target: string,
  platform: string | undefined = hostPlatform()
): string {
  if (platform !== "win32" && !WINDOWS_ABSOLUTE.test(target)) return target;
  // The long prefix only lifts MAX_PATH, which Node already does itself.
  const long = LONG_PREFIX.exec(target);
  const plain =
    long == null
      ? target
      : long[1] != null
        ? target.slice(long[0].length - long[1].length)
        : `\\\\${target.slice(long[0].length)}`;
  return plain.replaceAll("\\", "/");
}

interface PathedSkill {
  filePath: string;
  baseDir: string;
}

/**
 * pi resource-loader hooks: skill locations and AGENTS.md paths reach the
 * system prompt as written here. Spread into every DefaultResourceLoader.
 */
export const MODEL_PATH_RESOURCES = {
  skillsOverride: <T extends { skills: PathedSkill[] }>(base: T): T => ({
    ...base,
    skills: base.skills.map((skill) => ({
      ...skill,
      filePath: modelPath(skill.filePath),
      baseDir: modelPath(skill.baseDir),
    })),
  }),
  agentsFilesOverride: <T extends { agentsFiles: Array<{ path: string }> }>(
    base: T
  ): T => ({
    ...base,
    agentsFiles: base.agentsFiles.map((file) => ({
      ...file,
      path: modelPath(file.path),
    })),
  }),
};
