// Browser side of the private-GitHub-repository sync. Records are branches `tv-…`
// whose single parentless commit carries the properties as its message; the PC's
// snapshot branch also holds `snapshot.json.gz` (see src-tauri/src/cloud/github.rs).
import { AuthExpired, decodeJson, type RemoteFile } from './remote';

const API = 'https://api.github.com';
export interface GithubConfig { repo: string; token: string }

export const validRepo = (repo: string) => /^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo) && !repo.split('/')[1].startsWith('.');
export const validToken = (token: string) => /^(github_pat_|ghp_)[A-Za-z0-9_]{16,250}$/.test(token);

/** Commit sha → properties, so unchanged branches cost no extra request. */
const commits = new Map<string, { message: Record<string, string>; date: string }>();
export function clearGithubCache() { commits.clear(); }

async function call(cfg: GithubConfig, path: string, init: RequestInit = {}, accept = 'application/vnd.github+json') {
  let response: Response;
  try {
    response = await fetch(`${API}/repos/${cfg.repo}${path}`, {
      ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    });
  } catch { throw new Error('GitHub에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  if (response.ok) return response;
  if (response.status === 401) throw new AuthExpired('GitHub 토큰이 만료됐거나 취소됐어요. 새 토큰으로 다시 연결해 주세요.');
  if (response.status === 404) throw new NotFound();
  if (response.status === 409) throw new Error('GitHub 저장소가 비어 있어요. README 파일을 하나 만든 뒤 다시 시도해 주세요.');
  if (response.status === 403 || response.status === 429) {
    const text = await response.text().catch(() => '');
    throw new Error(/rate limit/i.test(text) ? 'GitHub 요청 한도를 넘었어요. 잠시 후 다시 시도해 주세요.' : '토큰에 이 저장소의 Contents 읽기·쓰기 권한이 없어요.');
  }
  throw new Error(`GitHub 요청에 실패했어요 (HTTP ${response.status}).`);
}
class NotFound extends Error { constructor() { super('저장소를 찾을 수 없어요. 이름과 토큰의 저장소 접근 범위를 확인해 주세요.'); } }
const json = async (r: Response) => r.json() as Promise<Record<string, unknown>>;

/** Connection check: the token works and the repository is private and readable. */
export async function checkRepo(cfg: GithubConfig) {
  const info = await json(await call(cfg, ''));
  if (info.private !== true) throw new Error('공개 저장소는 사용할 수 없어요. 비공개(Private) 저장소를 사용해 주세요.');
  await listFiles(cfg);
}

export async function listFiles(cfg: GithubConfig): Promise<RemoteFile[]> {
  const refs = await (await call(cfg, '/git/matching-refs/heads/tv-')).json() as { ref?: string; object?: { sha?: string } }[];
  const files: RemoteFile[] = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const name = r.ref?.startsWith('refs/heads/') ? r.ref.slice('refs/heads/'.length) : null;
    const sha = r.object?.sha;
    if (!name || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    let info = commits.get(sha);
    if (!info) {
      const commit = await json(await call(cfg, `/git/commits/${sha}`));
      const message: Record<string, string> = {};
      try {
        const parsed = JSON.parse(String(commit.message ?? '').trim());
        for (const [k, v] of Object.entries(parsed ?? {})) if (typeof v === 'string') message[k] = v;
      } catch { /* not a Token View record */ }
      info = { message, date: String((commit.committer as { date?: string } | undefined)?.date ?? '') };
      commits.set(sha, info);
    }
    files.push({ id: name, name, modifiedTime: info.date, appProperties: info.message });
  }
  return files;
}

export async function downloadJson(cfg: GithubConfig, branch: string): Promise<unknown> {
  return decodeJson(await call(cfg, `/contents/snapshot.json.gz?ref=${encodeURIComponent(branch)}`, {}, 'application/vnd.github.raw'));
}

/** Points branch `name` at a new parentless commit whose message holds `props`. */
export async function putProps(cfg: GithubConfig, _id: string | null, name: string, props: Record<string, string>): Promise<RemoteFile> {
  const post = async (path: string, body: unknown) => json(await call(cfg, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const message = JSON.stringify(props);
  const tree = await post('/git/trees', { tree: [{ path: 'meta.json', mode: '100644', type: 'blob', content: message }] });
  const commit = await post('/git/commits', { message, tree: tree.sha, parents: [] });
  try {
    await call(cfg, `/git/refs/heads/${name}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: true }) });
  } catch (error) {
    // A missing branch answers 422 (or 404): create it.
    if (!(error instanceof NotFound) && !(error instanceof Error && /HTTP 422/.test(error.message))) throw error;
    await post('/git/refs', { ref: `refs/heads/${name}`, sha: commit.sha });
  }
  return { id: name, name, modifiedTime: new Date().toISOString(), appProperties: props };
}
