# Token View 개인정보처리방침 · Privacy Policy

시행일: 2026-10-15

Token View는 Claude Code와 Codex 사용량을 보여 주는 오픈소스 앱이에요(PC용 Windows 앱, Android 앱, 웹앱). 개발자는 서버를 운영하지 않고, 사용자의 데이터를 받거나 보관하지 않아요.

## 처리하는 정보

- **PC 사용 기록:** PC 앱은 이 PC의 Claude Code·Codex 로그에서 토큰 수, 모델, 프로젝트 이름, 시각, 사용 한도를 읽어 이 PC에만 저장해요. 대화 내용은 읽지 않아요.
- **휴대폰 동기화(선택):** 사용자가 직접 연결한 경우에만, 위 통계를 아래 중 한 곳에 올려요.
  - 사용자 본인의 **구글 드라이브 앱 전용 공간**(`drive.appdata`): Token View만 접근할 수 있는 숨겨진 폴더예요. 드라이브의 다른 파일은 보거나 바꾸지 않아요.
  - 사용자 본인의 **GitHub 비공개 저장소**: 사용자가 만든 토큰으로 그 저장소에만 접근해요.
- **구글 계정 이메일:** 어떤 계정에 연결됐는지 화면에 보여 주는 데만 써요.

## Google 사용자 데이터

- Token View는 `drive.appdata`와 이메일(`openid`, `email`) 권한만 요청해요.
- 받은 정보는 사용자 본인의 기기끼리 기록을 주고받는 데만 쓰고, 개발자나 제3자에게 보내지 않아요. 광고, 판매, AI 모델 학습에도 쓰지 않아요.
- Token View의 Google API 데이터 사용은 [Google API 서비스 사용자 데이터 정책](https://developers.google.com/terms/api-services-user-data-policy)과 제한적 사용(Limited Use) 요건을 따라요.

## 보관과 삭제

- **로그인 정보:** PC는 Windows 자격 증명 관리자에, Android 앱은 Google Play 서비스에, 웹앱은 그 브라우저에 보관해요.
- **연결 해제:** 앱에서 연결을 해제하면 그 기기의 로그인 정보와 캐시를 지우고, 구글 권한도 철회해요.
- **동기화 기록 삭제:** 드라이브 기록은 구글 드라이브 설정 → 앱 관리에서 Token View의 숨겨진 데이터를 삭제하면 돼요. GitHub 기록은 저장소를 지우면 돼요.
- **권한 철회:** <https://myaccount.google.com/permissions>에서 언제든지 Token View의 접근 권한을 철회할 수 있어요.

## 문의

<https://github.com/frotrue/token-view/issues>

---

**English summary.** Token View has no server and the developer receives no user data. Usage statistics stay on the user's PC. They are uploaded only when the user connects sync, and only to the user's own Google Drive app-data folder (`drive.appdata`) or the user's own private GitHub repository. The Google account email is used only to label the connection. Data from Google APIs is used solely to sync the user's own devices: it is not shared, sold, used for advertising or used to train AI models. Token View's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Disconnecting in the app removes local tokens and revokes Google access. Access can also be revoked at <https://myaccount.google.com/permissions>. Contact: GitHub issues.
