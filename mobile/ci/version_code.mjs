// Android versionCode for the root package.json version. Tauri's default ignores the
// pre-release part, so 0.3.0-beta.2 and 0.3.0-beta.3 would share one code.
// x.y.z-beta.N -> (x*1e6 + y*1e3 + z)*100 + N, and a final release uses N = 99.
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/.exec(version);
if (!m) throw new Error(`unsupported version ${version}`);
const [, major, minor, patch, pre] = m.map(Number);
const n = m[4] === undefined ? 99 : pre;
if (n > 98 && m[4] !== undefined) throw new Error(`pre-release number too large: ${version}`);
console.log(((major * 1000 + minor) * 1000 + patch) * 100 + n);
