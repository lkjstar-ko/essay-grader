const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY   = process.env.GEMINI_API_KEY_PAID;
const BASE  = 'https://generativelanguage.googleapis.com/v1beta/models/';
const URL_PRO   = `${BASE}gemini-2.5-pro:generateContent?key=${KEY}`;
const URL_FLASH = `${BASE}gemini-2.5-flash:generateContent?key=${KEY}`;

const rubricCache = new Map();
function resolveRubric(rubricId, pdfBase64) {
  if (pdfBase64) {
    if (rubricId) rubricCache.set(rubricId, pdfBase64);
    return pdfBase64;
  }
  return rubricId ? (rubricCache.get(rubricId) ?? null) : null;
}

async function callGemini(url, parts, jsonMode) {
  const config = jsonMode
    ? { temperature: 0.1, responseMimeType: 'application/json' }
    : { temperature: 0.1 };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: config })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates[0].content.parts[0].text.trim();
  if (!jsonMode) return text;
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start)
    throw new Error('JSON 파싱 실패: 중괄호 없음 / 원문: ' + text.slice(0, 100));
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error(`JSON 파싱 실패: ${e.message} / 원문: ${text.slice(0, 100)}`); }
}

// ── /api/parse : 루브릭 추출 (Pro → Flash 폴백) ──
app.post('/api/parse', async (req, res) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 필요' });

    const prompt = `당신은 교육 평가 전문가입니다. 첨부된 PDF의 채점 기준을 분석하여 루브릭을 추출하세요.

[1단계: PDF 구조 파악]
아래 다양한 형태 중 어떤 구조인지 먼저 파악하세요:
- 표(Table) 형태: 행=평가항목, 열=수준/점수 또는 행=수준, 열=항목
- 텍스트 서술형: 항목과 기준을 문장으로 설명
- 체크리스트형: 항목별 O/X 또는 이행/미이행 구조
- 계층형: 대항목 아래 소항목이 있는 구조
- 혼합형: 위 형태들이 섞인 구조

[2단계: 공통 추출 원칙]
구조와 관계없이 아래 원칙으로 추출하세요:
1. 평가 항목(name): PDF에 명시된 항목명 그대로. 계층형이면 "대항목 > 소항목" 형태로.
2. 배점(min/max): PDF에 명시된 값 그대로. 예외 처리:
   - 배점 없이 등급만(A/B/C/D): 등급 수에 따라 max를 4/3점 단위로 배분
   - 총점만 있고 항목별 배점 없음: 항목 수로 균등 배분
   - 이행/미이행(O/X)형: min=0, max=1
   - 배점 범위(예: 8~10점): min=8, max=10
3. 평가 기준(description): 항목이 평가하는 내용을 구체적으로. 항목명 단순 반복 금지.
4. 수준별 기술어(criteria): 상/중/하, A/B/C/D 등 수준 구분이 있으면 추출. 없으면 빈 배열([]).
5. 계층형이면 소항목 단위로 분리.

[3단계: 검증]
- totalMax가 PDF 총점과 일치하는가?
- 누락 항목은 없는가?
- min <= max 인가?

반드시 아래 JSON만 출력하세요:
{"rubrics":[{"name":"항목명","min":최저점숫자,"max":최고점숫자,"description":"구체적 평가 기준","criteria":[{"level":"수준명","score":점수숫자,"desc":"수준 기술어"}]}],"totalMin":최저점합계,"totalMax":최고점합계,"notes":"PDF 구조 유형 및 특이사항"}`;

    const parts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt }
    ];

    let result;
    try { result = await callGemini(URL_PRO, parts, true); }
    catch (proErr) {
      console.log('Pro 모델 실패, Flash로 폴백:', proErr.message);
      result = await callGemini(URL_FLASH, parts, true);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/parse-achievement : 성취기준 추출 (Flash) ──
app.post('/api/parse-achievement', async (req, res) => {
  try {
    const { fileBase64, mimeType = 'application/pdf' } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 필요' });

    const prompt =
      '첨부된 파일에서 교육과정 성취기준을 모두 추출하세요.\n' +
      '성취기준 코드(예: [9사01-01])와 내용을 원문 그대로 유지하되,\n' +
      '불필요한 머리말·꼬리말·표 형식 기호는 제거하세요.\n' +
      '추출된 성취기준 텍스트만 출력하세요. 다른 설명 없이.';

    const parts = [
      { inline_data: { mime_type: mimeType, data: fileBase64 } },
      { text: prompt }
    ];

    const text = await callGemini(URL_FLASH, parts, false);
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 채점 프롬프트 공통 빌더 ──
function buildGradePrompt(rubrics, question, modelAnswer, studentName) {
  const totalMax = rubrics.reduce((s, r) => s + r.max, 0);

  const gradeGuide = `등급 기준 (총점 ${totalMax}점 기준):
  A+: ${Math.round(totalMax * 0.95)}점 이상
  A:  ${Math.round(totalMax * 0.90)}점 이상
  B+: ${Math.round(totalMax * 0.85)}점 이상
  B:  ${Math.round(totalMax * 0.80)}점 이상
  C+: ${Math.round(totalMax * 0.70)}점 이상
  C:  ${Math.round(totalMax * 0.60)}점 이상
  D:  ${Math.round(totalMax * 0.50)}점 이상
  F:  ${Math.round(totalMax * 0.50)}점 미만`;

  const rubricDetail = rubrics.map((r, i) => {
    const criteriaStr = r.criteria?.length
      ? '\n   수준별 기준:\n' + r.criteria.map(c => `   - ${c.level}(${c.score}점): ${c.desc}`).join('\n')
      : `\n   (수준별 기준 없음 — ${r.min}~${r.max}점 범위 내 답안 수준에 따라 부여)`;
    return `${i + 1}. [${r.name}] ${r.min}~${r.max}점\n   평가 기준: ${r.description || ''}${criteriaStr}`;
  }).join('\n\n');

  const prompt =
    `당신은 교육 평가 전문가입니다. 첨부된 두 PDF(①채점 기준, ②학생 답안)를 분석하여 채점하세요.\n\n` +
    `[평가 대상]\n` +
    (studentName ? `학생: ${studentName}\n` : '') +
    (question ? `문제: ${question}\n\n` : '문제: ①번 PDF(채점 기준)에 포함된 문제를 참고하세요.\n\n') +
    (modelAnswer ? `[모범 답안]\n${modelAnswer}\n\n` : '') +
    `[채점 루브릭 — 총 ${totalMax}점]\n${rubricDetail}\n\n` +
    `[채점 지침]\n` +
    `1. ②번 PDF의 학생 답안 전체를 꼼꼼히 읽으세요.\n` +
    `2. 각 루브릭 항목별로 답안의 관련 내용을 찾아 대조하세요.\n` +
    `3. 수준별 기준이 있으면 해당 수준의 점수를 부여하세요.\n` +
    `   수준별 기준이 없으면 답안 완성도에 따라 min~max 범위 내에서 부여하세요.\n` +
    `4. 루브릭 기준에 엄격하게 근거하여 채점하세요. 점수를 관대하게 주지 마세요.\n` +
    `5. 점수는 반드시 각 항목의 min 이상 max 이하여야 합니다.\n` +
    `6. 피드백은 답안의 구체적 내용을 언급하며 잘한 점과 개선점을 2~3문장으로 서술하세요.\n\n` +
    `${gradeGuide}\n\n` +
    `반드시 아래 JSON만 출력하세요:\n` +
    `{"rubrics":[{"name":"항목명","min":최저점,"max":최고점,"score":부여점수,"feedback":"피드백 2~3문장"}],` +
    `"total":합계점수,"totalMax":${totalMax},"grade":"등급"}`;

  return { prompt, totalMax };
}

// ── 세특 프롬프트 빌더 ──
function buildSetechPrompt(question, achievementSection, setechLength) {
  return `당신은 교과 담당 교사입니다. 첨부된 학생의 수행평가 답안을 바탕으로 학교생활기록부 교과 세부능력 및 특기사항(세특)을 작성하세요.

[수행평가 문제]
${question || '첨부된 답안 PDF의 문제 내용을 참고하세요.'}

[학생 답안 — 첨부 PDF 참고]

${achievementSection}[세특 작성 원칙]
- 단순 활동 나열이 아닌, 답안에서 드러난 학생의 사고 과정과 역량을 교사가 포착하여 기술하세요.
- 성찰 역량화: 어려움은 끈기로, 흥미는 학습 호기심으로 변환하여 기술하세요.
- 분량: 공백 포함 ${setechLength}byte 이내, 한 개의 문단.
- 수치, 백분율(%), 괄호()와 그 내용을 모두 제외.
- 어미: ~함, ~보임, ~구현함 등 교사의 관찰자 시점 유지.
- 금지: 학생은/학생이/학생 이름 등 학생 직접 지칭.
- 금지: 체득함, 느꼈음, 이해함, 알게 됨, 깨달음, ~을 느낌 등 내면 묘사.
- 허용: 이해도가 높음, 태도가 돋보임, 역량을 발휘함 등 관찰 가능한 표현.
- 외래어 최소화, 동일 단어 반복 금지.
- 학생의 발전 가능성이 드러나도록 긍정적으로 서술.

세특 문구만 출력하세요. JSON 없이 순수 텍스트로만.`;
}

function validateGradeBody(body) {
  if (!body.rubrics?.length) return '필수 항목 누락';
  if (!body.pdfBase64 && !body.rubricId) return '루브릭 PDF 필요';
  if (!body.answerPdfBase64) return '답안 PDF 필요';
  return null;
}

// ── /api/grade : 채점 + 세특 ──
app.post('/api/grade', async (req, res) => {
  const err = validateGradeBody(req.body);
  if (err) return res.status(400).json({ error: err });

  try {
    const {
      pdfBase64 = null, rubricId = null, answerPdfBase64, question, modelAnswer, studentName,
      rubrics, achievementStandard = '', setechLength = 500,
      modelAnswerPdfBase64 = null
    } = req.body;

    const rubricData = resolveRubric(rubricId, pdfBase64);
    if (!rubricData) return res.status(400).json({ error: '루브릭 PDF 필요 (캐시 만료)' });

    const built = buildGradePrompt(rubrics, question, modelAnswer, studentName);

    const achievementSection = achievementStandard
      ? `[성취기준]\n${achievementStandard}\n위 성취기준을 참고하여 학생이 어느 수준에 도달했는지 세특에 자연스럽게 반영하세요.\n\n`
      : '';

    const gradeParts = [
      { inline_data: { mime_type: 'application/pdf', data: rubricData } },
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: built.prompt }
    ];
    const setechParts = [
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } }
    ];
    if (modelAnswerPdfBase64) {
      setechParts.push({ inline_data: { mime_type: 'application/pdf', data: modelAnswerPdfBase64 } });
    }
    setechParts.push({ text: buildSetechPrompt(question, achievementSection, setechLength) });

    const [gradeResult, setechText] = await Promise.allSettled([
      callGemini(URL_FLASH, gradeParts, true),
      callGemini(URL_FLASH, setechParts, false)
    ]);

    if (gradeResult.status === 'rejected') throw new Error(gradeResult.reason?.message || '채점 실패');
    const result = gradeResult.value;
    result.setech = setechText.status === 'fulfilled' && typeof setechText.value === 'string'
      ? setechText.value : '';

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/regrade : 추가 채점 (세특 없이 채점만) ──
app.post('/api/regrade', async (req, res) => {
  const err = validateGradeBody(req.body);
  if (err) return res.status(400).json({ error: err });

  try {
    const { pdfBase64 = null, rubricId = null, answerPdfBase64, question, modelAnswer, studentName, rubrics } = req.body;
    const rubricData = resolveRubric(rubricId, pdfBase64);
    if (!rubricData) return res.status(400).json({ error: '루브릭 PDF 필요 (캐시 만료)' });
    const built = buildGradePrompt(rubrics, question, modelAnswer, studentName);

    const gradeParts = [
      { inline_data: { mime_type: 'application/pdf', data: rubricData } },
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: built.prompt }
    ];

    const gradeResult = await callGemini(URL_FLASH, gradeParts, true);
    res.json(gradeResult);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/split-pdf : 통합 PDF 분할 ──
app.post('/api/split-pdf', async (req, res) => {
  try {
    const { pdfBase64, studentCount, splitMode, pagesPerStudent = 1 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 필요' });
    const count = parseInt(studentCount);
    if (!count || count < 1 || count > 50) return res.status(400).json({ error: '학생 수는 1~50이어야 합니다' });

    const { PDFDocument } = require('pdf-lib');
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const srcDoc = await PDFDocument.load(pdfBytes);
    const totalPages = srcDoc.getPageCount();

    let ranges = [];

    if (splitMode === 'auto') {
      const prompt = `이 PDF는 ${count}명 학생의 답안이 순서대로 합쳐진 통합 PDF입니다.
총 페이지 수: ${totalPages}페이지.

[학생 이름 추출 방법 - 아래 방법을 순서대로 시도하세요]
1. 상단 표나 헤더에 "이름" 또는 "성명" 레이블이 있으면 그 옆 값 추출
2. 표나 레이블 없이 페이지 상단에 이름처럼 보이는 2~4글자 한글이 있으면 추출
3. "번호", "학번", "No" 등 번호 필드 근처의 한글 이름 추출
4. 위 방법으로도 못 찾으면 null 반환

[페이지 경계 분석]
- 새로운 학생 답안이 시작되는 기준: 새로운 이름/번호가 나타나거나, 동일한 양식이 반복되거나, 새로운 답안지 첫 페이지처럼 보이는 경우
- 모든 페이지(1~${totalPages})가 빠짐없이 포함되어야 합니다
- 이름을 못 찾더라도 페이지 경계는 반드시 분석하세요

반드시 JSON만 출력하세요:
{"students":[{"name":"이름 또는 null","startPage":1,"endPage":2}]}`;

      const parts = [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: prompt }
      ];

      let result;
      try {
        result = await callGemini(URL_FLASH, parts, true);
      } catch (e) {
        console.log('자동 분할 Gemini 오류:', e.message);
        result = { students: [] };
      }
      const students = result.students || [];

      if (students.length > 0) {
        ranges = students.map((s, i) => ({
          start: Math.max(0, (s.startPage || 1) - 1),
          end: Math.min(totalPages - 1, (s.endPage || s.startPage || 1) - 1),
          name: s.name === null ||
                s.name === 'null' ||
                s.name === '이름 또는 null' ||
                !s.name ? null : s.name.trim()
        }));
      } else {
        const pages = Math.ceil(totalPages / count);
        for (let i = 0; i < count; i++) {
          const start = i * pages;
          if (start >= totalPages) break;
          ranges.push({ start, end: Math.min(start + pages - 1, totalPages - 1), name: `학생${i + 1}` });
        }
      }
    } else {
      const pages = splitMode === '1' ? 1 : splitMode === '2' ? 2 : Math.max(1, parseInt(pagesPerStudent) || 1);
      for (let i = 0; i < count; i++) {
        const start = i * pages;
        if (start >= totalPages) break;
        ranges.push({ start, end: Math.min(start + pages - 1, totalPages - 1), name: `학생${i + 1}` });
      }

      // 이름만 별도 추출 (페이지 경계는 수동 계산값 유지)
      try {
        const firstPageList = ranges.map((r, i) => `학생 ${i + 1}: ${r.start + 1}페이지`).join('\n');
        const namePrompt = `이 PDF는 ${ranges.length}명 학생의 답안이 순서대로 합쳐진 통합 PDF입니다.
각 학생의 답안은 ${pages}페이지씩 구성됩니다.

[이름 추출 대상 페이지 — 반드시 아래 페이지에서만 추출하세요]
${firstPageList}

다른 페이지(두 번째 페이지 이후)는 무시하세요. 이름은 각 학생의 첫 페이지에만 있습니다.

[이름 추출 방법 - 순서대로 시도]
1. 상단 표나 헤더에 "이름" 또는 "성명" 레이블이 있으면 그 옆 값 추출
2. 페이지 상단에 2~4글자 한글 이름처럼 보이는 텍스트 추출
3. "번호", "학번", "No" 등 번호 필드 근처의 한글 이름 추출
4. 찾지 못한 학생은 null

반드시 JSON만 출력하세요 (학생 수: ${ranges.length}명):
{"names":["홍길동","김철수",null]}`;

        const nameParts = [
          { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
          { text: namePrompt }
        ];
        const nameResult = await callGemini(URL_FLASH, nameParts, true);
        const names = nameResult.names || [];
        names.forEach((rawName, i) => {
          if (!ranges[i]) return;
          const name = rawName === null || rawName === 'null' || !rawName ? null : String(rawName).trim();
          if (name) ranges[i].name = name;
        });
      } catch (e) {
        console.log('수동 분할 이름 추출 오류:', e.message);
      }
    }

    const splitResults = [];
    for (const range of ranges) {
      const destDoc = await PDFDocument.create();
      const indices = [];
      for (let p = range.start; p <= range.end; p++) indices.push(p);
      if (!indices.length) continue;
      const copied = await destDoc.copyPages(srcDoc, indices);
      copied.forEach(p => destDoc.addPage(p));
      const bytes = await destDoc.save();
      splitResults.push({
        name: range.name || `학생${splitResults.length + 1}`,
        base64: Buffer.from(bytes).toString('base64'),
        pageRange: `${range.start + 1}~${range.end + 1}페이지`
      });
    }

    res.json({ students: splitResults });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행중: http://localhost:${PORT}`);
  console.log('API 키: ' + (KEY ? '로드됨' : '없음'));
  console.log('모델: 루브릭 추출 → Pro(Flash 폴백) / 채점+세특 → Flash');
});
