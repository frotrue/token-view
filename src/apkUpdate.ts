import { invoke } from "@tauri-apps/api/core";

// The phone app is sideloaded, so it looks for updates on GitHub Releases itself.
const RELEASES = "https://api.github.com/repos/frotrue/token-view/releases?per_page=20";
const DOWNLOAD = "https://github.com/frotrue/token-view/releases/download/";
const APK = /_android-arm64\.apk$/;

type Version = { core: number[]; pre: (number | string)[] };

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** Semver precedence: 0.3.0-beta.2 < 0.3.0-beta.10 < 0.3.0 < 0.3.1-beta.1. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

export type Release = {
  tag_name: string;
  draft?: boolean;
  assets?: { name: string; browser_download_url: string }[];
};
export type ApkUpdate = { version: string; url: string };

/**
 * The newest release newer than `current` that has a phone APK. Pre-releases are
 * offered only to pre-release installs, so a stable install stays on stable.
 */
export function pickApk(releases: Release[], current: string): ApkUpdate | null {
  const installed = parseVersion(current);
  if (!installed) return null;
  let best: ApkUpdate | null = null;
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, "");
    const parsed = parseVersion(version);
    if (release.draft || !parsed || (parsed.pre.length && !installed.pre.length)) continue;
    const asset = release.assets?.find((a) => APK.test(a.name) && a.browser_download_url.startsWith(DOWNLOAD));
    if (!asset || compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, url: asset.browser_download_url };
  }
  return best;
}

export async function findApkUpdate(current: string): Promise<ApkUpdate | null> {
  const res = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const releases: unknown = await res.json();
  return Array.isArray(releases) ? pickApk(releases as Release[], current) : null;
}

/** Downloads the APK and opens the system installer; resolves once it is shown. */
export async function installApk(url: string): Promise<void> {
  await invoke("plugin:apk-update|install", { url });
}
