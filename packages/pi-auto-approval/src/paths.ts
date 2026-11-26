import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// Callers with raw tool input should apply resolveToolPath first.
export function resolvePathForPolicy(path: string, cwd = process.cwd()): string {
  let candidate = resolve(cwd, path);
  const missing: string[] = [];
  let followedLinks = 0;
  while (true) {
    try {
      return join(realpathSync.native(candidate), ...missing.reverse());
    } catch (error) {
      const parent = dirname(candidate);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === candidate) throw error;
      if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (++followedLinks > 40) {
          throw Object.assign(new Error(`Too many symbolic links resolving ${path}`), { code: "ELOOP" });
        }
        const target = readlinkSync(candidate);
        // Preserve target components: the filesystem must resolve symlinks before `..`.
        if (isAbsolute(target)) {
          candidate = target;
        } else {
          const directory = realpathSync.native(parent);
          candidate = directory + (directory.endsWith(sep) ? "" : sep) + target;
        }
        continue;
      }
      const component = basename(candidate);
      // A missing component before `..` cannot be resolved by appending a suffix.
      if (component === "..") throw error;
      if (component !== ".") missing.push(component);
      candidate = parent;
    }
  }
}

export function foldPath(path: string): string {
  return path.toLowerCase().normalize("NFC");
}

export function isPathInsideOrEqual(path: string, directory: string): boolean {
  const target = foldPath(resolve(path));
  const root = foldPath(resolve(directory));
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
