# BioNexus 점심 고르기

출근한 사람을 체크하면 그 사람들이 좋아하는 메뉴는 위로, 싫어하는 메뉴는 아래로 정렬해 주는 웹 페이지입니다.
Claude Code(AI 코딩 에이전트)로 개발했고, 카카오맵 API로 사무실 근처 식당을 찾아 줍니다.

👉 **바로 사용하기: https://andrew010417.github.io/what_lunch_do_you_want/**

![BioNexus 점심 고르기 화면](assets/screenshot.webp)

## 저장소
| 위치 | 주소 |
|---|---|
| 웹페이지 (GitHub Pages) | https://andrew010417.github.io/what_lunch_do_you_want/ |
| GitHub | https://github.com/andrew010417/what_lunch_do_you_want |
| 사내 GitLab | https://gitlab.bionexus.co.kr/bionexus-enterprise/edu/onboarding_1th/what_lunch_do_you_want |

## 사무실
| 탭 | 위치 | 주소 |
|---|---|---|
| 강남편 | 강남 연구소 (기업부설연구소) | 서울특별시 서초구 강남대로 373 13층 |
| 광교1편 | 수원 본사 | 경기도 수원시 영통구 광교로 156 1104호, 광교비즈니스센터 |
| 광교2편 | 광교 기업부설연구소2 | 경기도 수원시 영통구 광교로 107 경기도경제과학진흥원 창업보육동 311호 |

## 사용한 기술
- HTML / CSS / JavaScript (빌드 도구 없음)
- 카카오맵 JavaScript API: 주소 → 좌표, 근처 식당 검색, 지도 핀
- Open-Meteo: 사무실 위치의 현재 날씨
- Supabase (선택): 기록 공유 저장소

## 기능
- 오늘 같이 먹는 사람을 이름으로 검색해서 추가 (사무실 상관없이) → 메뉴 순위 정렬 (좋아하는 사람 1명당 +1, 싫어하는 사람 1명당 -1)
- 사무실 탭 = 오늘 먹는 장소 (근처 가게, 날씨, 주소 기준)
- 가입·로그인: 이름 + 주 사무실 + **제일 좋아하는 음식**(비밀번호) → 본인 취향만 언제든 수정
- 한 명이라도 싫어하면 아예 숨기기 모드
- 사람을 누르면 그 사람의 취향 카드 (수정은 본인만)
- 오늘 먹은 메뉴 기록 → 최근 5일 안에 먹은 메뉴는 -1
- 메뉴별 근처 가게 등록 (이름, 도보 시간, 가격) + 카카오맵/네이버 지도 검색 링크
- 카카오맵으로 사무실 반경 1km 가게 자동 검색 + 지도 핀 표시 → "우리 가게로 저장"
- 먹은 뒤 가게 선택·👍/👎 평가 → 평가가 좋은 메뉴 +1, 별로인 메뉴 -1
- 날씨 반영: 비·눈/추움이면 #국물 +1, 더우면 #시원 +1 (자동 조회 실패 시 직접 선택)
- 기분 필터: 가볍게(#가벼움) / 든든하게(#든든) / 빨리(#빠름) +1
- 공동 1등 룰렛

## 실행
빌드 없이 `index.html`을 브라우저에서 열면 됩니다.
`data.js`에 Supabase 키를 넣으면 취향·기록·가게·평가가 모두와 실시간 공유되고, 비워 두면 그 브라우저에만 저장됩니다.

## 데이터 수정
`data.js`에서 메뉴(`MENUS`)와 사무실(`OFFICES`)을 고칠 수 있습니다.
사람은 코드에 적지 않고, 각자 페이지 오른쪽 위 🔑 로그인 / 가입에서 직접 가입합니다.

## 카카오맵 설정
1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가
2. 앱 키의 **JavaScript 키**를 `data.js`의 `KAKAO_JS_KEY`에 넣기 (또는 페이지에서 직접 입력)
3. [플랫폼 → Web]에 사이트 도메인 등록: `https://andrew010417.github.io`
4. 카카오맵 사용 설정(ON)이 필요하면 [제품 설정 → 카카오맵]에서 켜기

claude.ai 링크 안에서는 보안 정책 때문에 카카오맵 검색이 동작하지 않습니다. GitHub Pages 주소에서 사용하세요.

## Supabase 설정 (공유 저장)
1. https://supabase.com 에서 New project (Region: Northeast Asia (Seoul))
2. SQL Editor → New query → `supabase.sql` 내용을 붙여 넣고 Run
3. Project Settings → API (Data API) 에서 **Project URL**과 **anon / publishable 키**를 `data.js`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`에 넣기
   - `service_role` / `secret` 키는 절대 넣지 마세요.

### 로그인 관리
- 비밀번호(좋아하는 음식)는 서버에서 bcrypt로 암호화해 보관하고, 5번 틀리면 10분 잠깁니다.
- 비밀번호를 잊은 사람은 Supabase → Table Editor → `lunch_secrets`에서 그 사람 줄을 지우면, 다음 로그인 때 새 음식으로 다시 정할 수 있습니다.
- 사람을 아예 지우려면 `lunch_docs`에서 그 사람 id의 `people`·`prefs` 줄과 `lunch_secrets` 줄을 지웁니다.
- 같은 이름으로는 두 번 가입할 수 없습니다.
- 띄어쓰기와 대소문자는 구분하지 않습니다 ("마 라 탕" = "마라탕").
