import { describe, expect, it } from 'vitest';
import { compareVersions, pickApk, type Release } from '../../src/apkUpdate';

const DL = 'https://github.com/frotrue/token-view/releases/download';
const release = (tag: string, apk = true, extra: Partial<Release> = {}): Release => ({
  tag_name: tag,
  assets: [
    { name: `Token.View_${tag.slice(1)}_x64-setup.exe`, browser_download_url: `${DL}/${tag}/setup.exe` },
    ...(apk ? [{ name: `Token.View_${tag.slice(1)}_android-arm64.apk`, browser_download_url: `${DL}/${tag}/Token.View_${tag.slice(1)}_android-arm64.apk` }] : []),
  ],
  ...extra,
});

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const sorted = ['0.3.1-beta.1', '0.3.0', '0.3.0-beta.10', '0.2.0', '0.3.0-beta.2', '0.3.0-alpha.5'];
    sorted.sort(compareVersions);
    expect(sorted).toEqual(['0.2.0', '0.3.0-alpha.5', '0.3.0-beta.2', '0.3.0-beta.10', '0.3.0', '0.3.1-beta.1']);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });
});

describe('pickApk', () => {
  it('offers the newest release that has an APK', () => {
    const got = pickApk([release('v0.3.0-beta.4', false), release('v0.3.0-beta.3'), release('v0.3.0-beta.2')], '0.3.0-beta.2');
    expect(got).toEqual({ version: '0.3.0-beta.3', url: `${DL}/v0.3.0-beta.3/Token.View_0.3.0-beta.3_android-arm64.apk` });
  });

  it('returns null when nothing is newer', () => {
    expect(pickApk([release('v0.3.0-beta.2'), release('v0.2.0')], '0.3.0-beta.2')).toBeNull();
  });

  it('keeps stable installs on stable releases', () => {
    expect(pickApk([release('v0.4.0-beta.1')], '0.3.0')).toBeNull();
    expect(pickApk([release('v0.4.0-beta.1'), release('v0.3.1')], '0.3.0')?.version).toBe('0.3.1');
    expect(pickApk([release('v0.3.0')], '0.3.0-beta.2')?.version).toBe('0.3.0');
  });

  it('ignores drafts and downloads from anywhere else', () => {
    const foreign = release('v0.3.0-beta.5');
    foreign.assets![1].browser_download_url = 'https://evil.example/Token.View_0.3.0-beta.5_android-arm64.apk';
    expect(pickApk([release('v0.3.0-beta.6', true, { draft: true }), foreign], '0.3.0-beta.2')).toBeNull();
  });
});
