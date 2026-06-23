import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function tempDir(prefix = "b2-vscode-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
