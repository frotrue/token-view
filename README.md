# Token View

Claude Code와 Codex의 토큰 사용량, API 환산 비용, 사용 한도를 한 화면에서 보는 Windows 앱입니다. 지금 속도로 쓰면 한도와 예산이 언제 소진되는지도 예측합니다. **0.3.0 베타**에서는 선택적으로 클라우드에 동기화하고 모바일 웹앱에서 같은 기록을 볼 수 있습니다.

- **개요:** 누적 토큰과 비용, 이번 달 월말 예상, 한도 카드(소진 예상 시각), 일별 사용량(이번 달 남은 기간 예측 포함)
- **한도 · 예측:** 5시간·주간 한도의 현재 사용률, 현재 속도 기준 예측선, 지난 윈도우 기록
- **통계:** 토큰 구성과 캐시 적중률, 모델별·프로젝트별 표, 요일·시간대 패턴
- **통계 (세션 · 블록):** 세션별 비용, Claude 5시간 블록 이력(한도 도달 표시)
- **설정:** 모델 단가 편집, 월 예산, 원화 표시, 알림, 실시간 한도 조회, Claude 한도 수집 연결, 자동 실행, 내보내기(CSV/JSON), 업데이트 확인
- **트레이:** 한도 사용률을 막대로 보여 주는 아이콘, 마우스를 올리면 현재 %와 오늘 비용
- **알림:** 한도 80%/95% 도달, 리셋 전 소진 예상, 월 예산 초과(예상)일 때 Windows 알림
- **예측 범위:** 내 최근 사용 패턴(시간대별 변동)으로 계산한 10~90% 범위를 함께 표시
- **모바일 베타:** 홈 화면에 설치, PC별 기록 선택, 화면을 보고 있을 때 3분마다 갱신, 오프라인 기록 보기, JSON 가져오기·다운로드, 예산·환율 공유

## 모바일 · 클라우드 베타

PC가 수집한 통계와 한도를 본인 계정의 Supabase에 저장하고 휴대폰에서 읽습니다. 클라우드 동기화는 기본으로 꺼져 있습니다. PC가 꺼져 있으면 마지막 기록을 계속 볼 수 있습니다. 모바일의 **PC에 최신 한도 요청**은 실행 중인 PC에 수집을 요청하며, 제공자에 직접 로그인하는 기능은 포함하지 않습니다. 한도의 실제 마지막 확인 시각을 별도로 표시합니다.

1. [클라우드 설정 안내](docs/cloud-setup.md)에 따라 Supabase 테이블과 베타 계정을 만듭니다.
2. PC 설정에서 프로젝트 URL·공개 키를 입력하고 로그인한 뒤 동기화를 켭니다.
3. 모바일 사이트에서 같은 계정으로 로그인합니다. 설정의 설치 안내에 따라 홈 화면에 추가할 수 있습니다.

클라우드 없이 먼저 확인하려면 `npm ci && npm run dev`를 실행하고 **샘플 데이터 보기** 또는 **JSON 가져오기**를 선택하세요. 기존 PC 앱의 대시보드 JSON 내보내기도 읽을 수 있습니다. 샘플은 실제 사용량과 구별해 표시됩니다.

[베타 빌드·배포 안내](docs/beta-release.md) · [한도 직접 조회 검증](docs/provider-auth-feasibility.md) · [데이터 계약](docs/beta-contract.md)

## 설치

[Releases](https://github.com/frotrue/token-view/releases/latest)에서 `Token View_*_x64-setup.exe`를 내려받아 실행하세요.

- 서명되지 않은 개인 프로젝트라서 처음 실행할 때 SmartScreen 경고가 뜰 수 있어요. **추가 정보 → 실행**을 누르면 됩니다.
- 새 버전이 나오면 앱 상단에 알림이 뜨고, 버튼 한 번으로 업데이트할 수 있어요. 앱을 실행할 때와 6시간마다 확인합니다.
- 창을 닫으면 트레이로 숨겨진 채 계속 수집해요. 완전히 끄려면 트레이 아이콘 → **종료**를 누르세요.

## 데이터 출처

| 항목 | 위치 |
|---|---|
| Claude Code 사용량 | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR` 지원) |
| Codex 사용량 · 한도 | `~/.codex/sessions/**`, `~/.codex/archived_sessions/**` (`.jsonl`, `.jsonl.zst`, `CODEX_HOME` 지원) |
| Claude 한도 % | `~/.token-view/claude-rate-limits.jsonl` (상태줄 연결 시 기록) |
| 앱 DB | `%APPDATA%\com.tokenview.monitor\usage.db` |

- 로그는 증분으로 읽습니다. 원본 로그가 지워져도 DB에 남은 기록은 유지돼요.
- 클라우드 동기화를 끄면 사용 기록은 PC 안에서만 처리돼요. 기본 외부 연결은 업데이트 확인과 단가표 받기(GitHub), 서비스 상태 확인(status.claude.com, status.openai.com)입니다. Claude 사용량 API를 켜면 Anthropic 연결이 추가돼요.
- 클라우드 동기화를 켜면 화면용 사용량·한도·단가·표시 설정을 지정한 Supabase에 전송합니다. 원본 대화, 로그 파일, 제공자 로그인 토큰은 업로드하지 않습니다. 프로젝트는 폴더 이름과 구분용 해시로, 세션 ID는 해시로 전송합니다. PC의 클라우드 로그인 세션은 Windows 자격 증명 저장소, 모바일 세션은 브라우저 저장소에 보관합니다. 모바일 로그아웃은 개인 데이터 캐시를 지웁니다.

### 실시간 한도 조회

- **Codex:** 설치된 Codex CLI(`codex app-server`)에 현재 한도와 무료 리셋권을 직접 물어봐요. 기본으로 켜져 있어요.
- **Claude (베타, 기본 꺼짐):** Claude Code의 로그인 토큰으로 Anthropic의 비공식 사용량 API를 조회해요. 토큰은 Anthropic에만 보내고 저장하지 않아요.

### Claude 한도

Claude의 5시간·주간 한도 %는 **터미널 Claude Code의 상태줄 명령**에만 전달돼요.

- **실제 값:** 설정 → **Claude 한도 수집 → 자동 연결**을 누르면 Token View가 상태줄 명령으로 등록돼요. 기존 상태줄은 그대로 이어서 표시되고, `settings.json`은 처음 바꿀 때 `settings.json.bak-tokenview`로 백업됩니다. 연결 해제하면 원래대로 돌아가요.
- **추정 값:** 상태줄이 없을 때(예: 데스크톱 앱만 쓸 때)는 로그에 남은 "한도 도달" 기록을 기준으로 삼아, 지금까지 쓴 비용으로 사용률을 추정해요.

## 비용 계산

- 단가는 [`pricing.json`](pricing.json)에서 관리하고, 앱이 6시간마다 받아 옵니다. 그래서 가격만 바뀔 때는 앱을 새로 배포하지 않아도 돼요.
- 설정에서 단가를 직접 고치면 그 값을 계속 쓰고, **기본값으로**를 누르면 게시된 단가표로 돌아갑니다.
- Codex(OpenAI)는 `input_tokens`에 캐시 토큰이 포함돼 있어서, 캐시되지 않은 부분만 입력 단가로 계산해요. 272K 토큰을 넘는 긴 컨텍스트 요청에는 공식 배수(입력 2배, 출력 1.5배)를 적용합니다.
- 구독 요금제 사용자는 실제 청구액이 아니라 "같은 사용량을 API로 썼을 때 비용"이라고 보면 됩니다.

## 개발

```bash
npm install
npx tauri dev
```

- **단가 변경:** `src-tauri/src/pricing.rs`에서 표와 `BUILTIN_VERSION` 날짜를 고친 뒤 `pricing.json`을 다시 만들어 커밋하세요.
  ```bash
  cd src-tauri && cargo run --example pricing_json > ../pricing.json
  ```
- **검증:** `npm test`, `npm run build`, `npm run test:e2e`, `cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml`, `bash supabase/tests/run-postgres-tests.sh`.
- **베타 CI:** `Beta checks`가 웹 테스트·SQL 보안 테스트·Windows 테스트를 실행하고 모바일 정적 파일과 서명하지 않은 Windows 설치 프로그램을 아티팩트로 만듭니다. GitHub Release를 게시하지 않습니다.
- **릴리스:** `package.json`과 `src-tauri/Cargo.toml`의 버전을 맞추고 잠금 파일을 갱신한 뒤 `vX.Y.Z` 태그를 푸시하면 GitHub Actions가 빌드, 서명, 릴리스까지 처리해요. `v0.3.0-beta.1`처럼 하이픈이 있는 태그는 사전 릴리스로 게시됩니다. 저장소 Secrets에 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 있어야 합니다.
- **실제 로컬 기록으로 브라우저 확인:** 다음 명령으로 만든 JSON을 모바일 화면의 **JSON 가져오기**에서 선택하세요. 이 파일은 로컬 개발용으로 원본 경로가 포함될 수 있으므로 저장소에 커밋하지 마세요.
  ```bash
  cd src-tauri && cargo run --release --example snapshot -- <임시 db> ../.dev/snapshot.json
  ```
