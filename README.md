# Token View

Claude Code와 Codex의 토큰 사용량, API 환산 비용, 사용 한도를 한 화면에서 보는 Windows 앱입니다. 지금 속도로 쓰면 한도와 예산이 언제 소진되는지도 예측합니다.

- **개요:** 누적 토큰과 비용, 이번 달 월말 예상, 한도 카드(소진 예상 시각), 일별 사용량(이번 달 남은 기간 예측 포함)
- **한도 · 예측:** 5시간·주간 한도의 현재 사용률, 현재 속도 기준 예측선, 지난 윈도우 기록
- **통계:** 토큰 구성과 캐시 적중률, 모델별·프로젝트별 표, 요일·시간대 패턴
- **설정:** 모델 단가 편집, 월 예산, 원화 표시, Claude 한도 수집 연결, 업데이트 확인

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
- 모든 데이터는 내 PC 안에서만 처리돼요. 앱이 외부에 연결하는 건 업데이트 확인과 단가표 받기(GitHub) 두 가지뿐입니다.

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
- **릴리스:** `package.json`의 `version`을 올리고 `vX.Y.Z` 태그를 푸시하면 GitHub Actions가 빌드, 서명, 릴리스까지 처리해요. 저장소 Secrets에 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 있어야 합니다.
- **백엔드 없이 UI 보기:** `.dev/snapshot.json`을 만든 뒤 `npx vite`를 실행하세요.
  ```bash
  cd src-tauri && cargo run --release --example snapshot -- <임시 db> ../.dev/snapshot.json
  ```
