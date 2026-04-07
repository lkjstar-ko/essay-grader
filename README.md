# 서술형 채점기 — Render 배포 가이드

## 파일 구조

```
essay-grader/
├── public/
│   └── index.html     ← 프론트엔드 (API 키 없음)
├── server.js          ← Express 백엔드
├── package.json
├── .env.example       ← 환경변수 템플릿 (참고용)
├── .gitignore         ← .env는 git에 올리지 않음
└── README.md
```

---

## 배포 순서

### 1단계 — GitHub에 올리기

```bash
git init
git add .
git commit -m "first commit"

# GitHub에서 새 repository 만든 후:
git remote add origin https://github.com/본인계정/essay-grader.git
git push -u origin main
```

> ⚠️ `.env` 파일은 `.gitignore`에 있어서 자동으로 제외됩니다.

---

### 2단계 — Render 프로젝트 생성

1. [render.com](https://render.com) 접속 → 회원가입 (GitHub 계정으로 로그인 권장)
2. 대시보드에서 **New +** → **Web Service** 클릭
3. GitHub 연결 후 `essay-grader` repository 선택
4. 아래 설정 입력:

| 항목 | 값 |
|------|-----|
| Name | essay-grader (자유) |
| Region | Singapore (한국에서 가장 가까움) |
| Branch | main |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

---

### 3단계 — 환경변수 설정 (핵심!)

Render 프로젝트 → **Environment** 탭

| Key | Value |
|-----|-------|
| `GEMINI_API_KEY` | `AIza...실제키입력` |

→ **Save Changes** 클릭 → 자동 재배포

---

### 4단계 — 배포 완료

- 빌드 2~3분 후 `https://essay-grader-xxxx.onrender.com` URL 발급
- 이 URL 공유하면 누구나 바로 사용 가능

---

## ⚠️ Render 무료 플랜 주의사항

| 항목 | 내용 |
|------|------|
| Cold Start | 15분 이상 미사용 시 슬립 → 첫 접속 30~50초 걸림 |
| 월 사용량 | 750시간 (사실상 무제한) |
| PDF 크기 제한 | 없음 (30MB까지 허용) |

**Cold Start 해결법**: [UptimeRobot](https://uptimerobot.com) 무료 서비스로 5분마다 핑을 보내면 슬립 방지 가능

---

## 로컬 테스트 먼저

```bash
npm install
cp .env.example .env
# .env 파일 열어서 GEMINI_API_KEY=AIza... 입력

npm start
# → http://localhost:3000 접속
```

---

## 보안 구조

```
사용자 브라우저 (API 키 없음)
    ↓  HTTPS
Render 서버 /api/parse  /api/grade
    ↓  환경변수에서 키 로드
Gemini API
```

- 브라우저 개발자도구로 봐도 키 노출 없음
- Render 환경변수는 암호화 저장
- .env는 git에 올라가지 않음
