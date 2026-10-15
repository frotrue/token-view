# 모바일 클라우드 베타 설정

현재 이 저장소에는 실행 가능한 Supabase 마이그레이션과 로컬 보안 테스트가 들어 있다. 이 작업 환경에서 Supabase 프로젝트 생성, 사용자 생성 또는 외부 배포는 실행하지 않았다. 서버를 연결하지 않아도 모바일 JSON 가져오기와 명시적인 데모 모드를 사용할 수 있다.

## 1. Supabase 프로젝트 만들기

1. Supabase 대시보드에서 별도의 베타 프로젝트를 만든다. 데이터베이스 비밀번호는 비밀번호 관리자에 보관하고 저장소나 프런트엔드 환경 변수에 넣지 않는다.
2. 프로젝트가 준비되면 **Project Settings → API / Data API**에서 Project URL을 확인한다. 클라우드 URL은 `https://프로젝트참조.supabase.co` 형태다.
3. **Project Settings → API Keys**에서 **Publishable key** (`sb_publishable_…`)를 확인한다. 기존 프로젝트의 **Legacy anon key**도 사용할 수 있다. 모바일과 PC에는 같은 프로젝트 URL과 공개 키만 입력한다.
4. **Secret key** (`sb_secret_…`), `service_role` JWT, 데이터베이스 접속 문자열과 비밀번호는 어느 클라이언트에도 입력하지 않는다. 클라이언트는 비밀 키와 `service_role` 키를 거부한다. `VITE_` 환경 변수는 빌드 결과에 공개된다.

## 2. 데이터베이스 적용

Supabase **SQL Editor**에서 데이터베이스 관리자 `postgres` 역할로 다음 파일 전체를 한 번 실행한다.

```text
supabase/migrations/202610140001_private_cloud_beta.sql
```

파일은 하나의 트랜잭션으로 세 테이블, 소유자 읽기 정책과 네 RPC를 만든다. 중간 실패 시 전체가 롤백된다. 이미 성공한 마이그레이션을 SQL Editor에서 다시 실행하지 않는다. 이후 변경은 새 마이그레이션으로 적용한다.

CLI로 관리하려면 저장소 루트에서 Supabase CLI를 설치·로그인한 뒤 `supabase init`으로 로컬 설정을 만들고, 프로젝트를 연결한 다음 마이그레이션을 적용한다.

```sh
supabase init
supabase link --project-ref 프로젝트참조
supabase db push
```

SQL Editor 방식과 CLI 방식 중 하나로 최초 적용한다. SQL Editor로 먼저 적용한 데이터베이스를 나중에 CLI로 관리할 때에는 CLI 마이그레이션 기록을 실제 적용 상태와 맞춘 뒤 사용한다. `supabase/tests/bootstrap-local.sql`은 일반 PostgreSQL 테스트용 Auth 모형이다. 실제 Supabase에는 적용하지 않는다.

## 3. 이메일 로그인과 베타 사용자

1. **Authentication → Sign In / Providers → Email**에서 이메일·비밀번호 로그인을 활성화한다. 이 베타 앱에는 회원가입 화면이 없으므로 비공개 베타에서는 신규 공개 가입을 비활성화할 수 있다.
2. **Authentication → Users → Add user → Create new user**에서 베타 이메일과 초기 비밀번호를 지정한다. **Auto Confirm User**를 켜거나 사용자가 확인 메일을 완료한 뒤 로그인하도록 한다. 비밀번호는 앱 설정, `.env` 파일 또는 저장소에 기록하지 않는다.
3. **Authentication → URL Configuration**의 Site URL을 실제 모바일 사이트 HTTPS 주소로 설정한다. 확인 메일·비밀번호 재설정 링크를 사용할 경우 Redirect URLs에도 실제 사이트 주소를 등록한다. 개발 중에는 `http://localhost:5173` 같은 실제 개발 주소만 추가한다.
4. 이메일 확인·초대·재설정을 운영에서 사용하려면 프로젝트에 SMTP를 설정하고 Supabase의 현재 이메일 전송 제한을 확인한다. 기본 메일 전송만으로 많은 베타 사용자를 초대하지 않는다. 직접 생성한 확인 완료 계정은 메일 발송 없이 이메일·비밀번호로 로그인할 수 있다.
5. 같은 사용자 이메일로 PC와 모바일에 로그인한다. 사용자 A의 스냅샷, 설정과 요청은 사용자 B에게 보이지 않는다. 프로젝트 사용자 삭제 시 해당 사용자의 클라우드 데이터도 삭제된다.

## 4. 모바일 공개 설정

저장소 루트의 로컬 `.env.local` 또는 호스팅 서비스의 빌드 환경 변수에 다음 공개 설정을 지정한다. 아래 값은 자리표시자다.

```dotenv
VITE_SUPABASE_URL=https://프로젝트참조.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_공개키
```

`VITE_SUPABASE_ANON_KEY`에는 새 publishable key 또는 기존 anon JWT를 넣는다. 키 이름은 호환성을 위해 유지된다. `.env.local`은 커밋하지 않는다. 앱 설정 화면에서 URL과 공개 키를 입력하는 방식도 지원한다. 환경 변수를 변경했다면 Vite 개발 서버를 다시 시작하거나 모바일 사이트를 다시 빌드한다.

```sh
npm ci
npm run dev
# 배포할 정적 산출물 생성
npm run build
```

모바일 사이트는 HTTPS로 호스팅한다. 로그인을 완료한 뒤 PC가 첫 업로드를 마쳐야 장치 목록에 PC가 나타난다. 여러 PC는 각각의 장치로 표시하며 사용자가 한 번에 한 장치를 선택한다. 로그인 해제는 모바일의 개인 캐시를 지운다. 별도의 클라우드 HTTP 서버, 서비스 계정 키 또는 제공자 토큰은 필요하지 않다.

## 5. PC 연결과 최초 확인

1. PC 앱 설정의 클라우드 항목에서 같은 프로젝트 URL과 공개 키, PC 이름을 입력한다. 클라우드 동기화를 활성화하고 베타 이메일·비밀번호로 로그인한다.
2. PC에서 동기화를 실행한다. Windows의 로그인 세션은 네이티브 자격 증명 저장소에 보관한다. 비 Windows 빌드는 앱에 표시되는 메모리 세션 조건을 따른다.
3. 모바일에서 로그인하고 해당 PC를 선택한다. 캡처 시각과 클라우드 조회 시각이 따로 표시되는지 확인한다.
4. 모바일의 **클라우드 데이터 새로고침**은 서버의 현재 데이터를 다시 읽는다. **PC 새로고침 요청**은 로그인된 PC의 다음 스캔을 요청한다. PC가 꺼져 있으면 새 스냅샷이 생기지 않는다.
5. 다른 베타 계정으로 로그인해 첫 계정의 장치·설정·요청을 볼 수 없는지 확인한다. 제공자 로그인 토큰 입력 UI는 없으며 제공자 토큰을 Supabase에 업로드하지 않는다.

## RPC와 제한

| RPC | 반환값 | 적용 조건 |
| --- | --- | --- |
| `publish_snapshot(p_device_id, p_device_name, p_captured_at, p_payload)` | 서버 업로드 시각 문자열 | 본인 장치 스냅샷만; 과거 캡처는 거부; 완전히 동일한 재시도는 원래 시각 반환 |
| `save_user_settings(p_settings)` | `{ user_id, settings, updated_at }` JSON 객체 | 다섯 표시·예산 필드만 허용; 전체 설정 객체 필요 |
| `request_refresh(p_device_id)` | `{ user_id, device_id, requested_at, handled_at }` JSON 객체 | 본인 스냅샷이 있는 장치만; 진행 중인 유효 요청 병합; 최소 60초 간격 |
| `acknowledge_refresh(p_device_id, p_requested_at)` | `true` 또는 `false` | 같은 요청 시각, 미완료·10분 미만 요청, 요청 이후 성공한 업로드 필요 |

세 테이블은 `authenticated` 사용자에게 본인 행의 SELECT만 허용한다. INSERT·UPDATE·DELETE는 클라이언트에 허용하지 않으며 인증된 RPC가 `auth.uid()`에서 소유자 ID를 결정한다. 익명 역할과 서비스 역할에는 테이블·RPC 권한을 부여하지 않는다. 서비스 역할 키는 사용하지 않는다. 데이터베이스 관리자는 관리 목적의 접근 권한을 가진다.

스냅샷은 JSONB로 직렬화한 크기가 4 MiB 이하이며 스키마 버전은 1이다. 장치 ID·이름과 캡처 시각이 RPC 인자와 일치해야 한다. 서버 기준 미래 5분보다 뒤의 캡처, 음수 시각, 무한 시각, 허용되지 않은 필드, 제공자 원문 오류와 절대 프로젝트 경로는 거부한다. 동일 캡처에 다른 내용을 덮어쓸 수 없다. 제한 초과 업로드는 실패해도 PC의 로컬 수집은 계속된다. 35일 상세 시계열과 최대 500개 세션을 유지한다.

공유 설정은 `currency` (`USD` 또는 `KRW`), `krwRate` (0 초과, 1,000,000 이하), `monthlyBudget`, `budgetClaude`, `budgetCodex` (각각 null 또는 0–1,000,000,000)만 포함한다. PC 자동 실행, 제공자 접근, 알림, 수집 주기, 파일 경로와 자격 증명은 공유하지 않는다.

요청 시각은 클라이언트가 지정할 수 없다. 10분 미만의 미완료 요청은 추가 클릭과 병합된다. 이미 완료한 요청도 요청 후 60초 이내면 기존 완료 상태를 반환하므로 클라이언트는 `handled_at`을 확인해야 한다. 만료된 요청은 PC가 실행하지 않는다. 늦게 도착한 이전 요청의 완료 처리는 더 새로운 요청을 지우지 못한다. 명령 종류나 임의 명령문을 저장하는 필드는 없다.

## 로컬 보안 검증

Docker가 실행되는 개발 환경에서 저장소 루트에서 다음을 실행한다.

```sh
./supabase/tests/run-postgres-tests.sh
```

스크립트는 PostgreSQL 16 컨테이너를 고유 이름으로 만들고 네트워크를 차단한다. 외부 포트를 열지 않으며 비밀번호나 실제 계정은 사용하지 않는다. 데이터는 임시 메모리에 저장하고 종료 시 자신이 생성한 컨테이너만 제거한다. 테스트는 허용적인 초기 테이블·함수 권한을 설정한 일반 PostgreSQL에 Supabase 역할과 JWT 사용자 ID 모형을 넣고, 실제 마이그레이션과 SQL 검증을 실행한다.

검증 범위에는 두 사용자 격리, 장치 UUID 복사, 익명·서비스 역할 접근 차단, 모든 직접 쓰기 차단, 사용자 ID 위조, 이전/동일 캡처 재시도, 미래/무한 시각, 4 MiB 크기 제한, 잘못된 표시·예산 설정, 제공자 토큰·원문 오류 필드 차단, 요청 병합·쿨다운·만료와 성공 업로드 전 완료 차단이 포함된다. 실제 네이티브 직렬화기가 만든 합성 스냅샷도 그대로 RPC에 전달해 저장 결과를 비교한다. 두 독립 SQL 연결이 동시에 업로드와 완료 처리를 시도하는 테스트로 행 잠금 대기 후에도 더 새로운 스냅샷과 요청이 유지되는지 검증한다. 보안·네이티브 스냅샷 테스트 데이터는 트랜잭션으로 롤백하며, 동시성 테스트의 합성 데이터는 임시 컨테이너 제거와 함께 폐기한다.

로컬 Supabase 프로젝트에서 같은 SQL을 실행하려면 데이터베이스 관리자 연결로 다음만 실행한다. Auth 모형 파일은 사용하지 않는다.

```sh
psql "$LOCAL_SUPABASE_TEST_DATABASE_URL" -X --set=ON_ERROR_STOP=1 -f supabase/tests/security.sql
```

이 테스트용 연결 변수에 운영 데이터베이스를 지정하지 않는다. 테스트는 실제 PostgreSQL의 SQL/RLS/권한 동작을 검증하며, 호스팅된 Supabase Auth·메일·PostgREST나 모바일/PC 간 운영 연결을 검증한 것으로 해석하지 않는다. 실제 프로젝트를 설정한 뒤 위의 두 계정 확인을 별도로 완료한다.
