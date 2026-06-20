import * as fs from "fs";

function isUnsupportedSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "ENOTSUP" || code === "EPERM";
}

export function createDirectorySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      return false;
    }
    throw error;
  }
}

export function createFileSymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      return false;
    }
    throw error;
  }
}
