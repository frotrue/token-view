// What both sync backends (Google Drive appDataFolder, private GitHub repository)
// look like to the reader: named records with string properties.
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export interface RemoteFile { id: string; name: string; modifiedTime: string; appProperties: Record<string, string> }

/** The credential no longer works: keep cached data and ask to reconnect. */
export class AuthExpired extends Error {
  constructor(message = '로그인이 만료됐어요. 다시 연결해 주세요.') { super(message); }
}

/** Reads a downloaded snapshot; gzip content (what the PC uploads) is inflated here. */
export async function decodeJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('PC 기록 파일이 너무 커요.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('PC 기록 파일이 너무 커요.');
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
    if (inflated.length > 4 * MAX_DOWNLOAD_BYTES) throw new Error('PC 기록 파일이 너무 커요.');
    text = new TextDecoder().decode(inflated);
  } else text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text); } catch { throw new Error('PC 기록 파일이 손상됐어요.'); }
}
