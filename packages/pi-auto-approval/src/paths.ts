import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// Callers with raw tool input should apply resolveToolPath first.
export function resolvePathForPolicy(path: string, cwd = process.cwd()): string {
  let candidate = resolve(cwd, path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(candidate), ...missing.reverse());
    } catch (error) {
      const parent = dirname(candidate);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === candidate) throw error;
      missing.push(basename(candidate));
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
