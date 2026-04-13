const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY_FREE = process.env.GEMINI_API_KEY_FREE;
const KEY_PAID = process.env.GEMINI_API_KEY_PAID;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// 키별 URL 생성
function makeUrl(model, key) {
  return BASE + model + ':generateContent?key=' + key;
}

// 단일 키로 API 호출
async function callGeminiWithKey(key, model, parts, jsonMode) {
  var config = jsonMode
    ? { temperature: 0.1, responseMimeType: 'application/json' }
    : { temperature: 0.1 };
  var res = await fetch(makeUrl(model, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: parts }], generationConfig: config })
  });
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  var text = data.candidates[0].content.parts[0].text;
  if (!jsonMode) return text.trim();
  var clean = text.trim();
  var start = clean.indexOf('{');
  var end = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) clean = clean.slice(start, end + 1);
  try { return JSON.parse(clean); }
  catch (e) { throw new Error('JSON 파싱 실패: ' + e.message + ' / 원문: ' + clean.slice(0, 100)); }
}

// 유료 키로만 호출 (무료 키 폴백 제거)
async function callGemini(model, parts, jsonMode) {
  var key = KEY_PAID || KEY_FREE;
  if (!key) throw new Error('API 키가 설정되지 않았습니다.');

  var isDemandError = function(msg) {
    return msg.includes('high demand') || msg.includes('temporarily') ||
           msg.includes('try again') || msg.includes('overloaded') ||
           msg.includes('503') || msg.includes('502');
  };

  try {
    return await callGeminiWithKey(key, model, parts, jsonMode);
  } catch (e) {
    var msg = e.message || '';
    // Flash 수요 폭주 시 Pro 폴백
    if (isDemandError(msg) && model === 'gemini-2.5-flash') {
      console.log('Flash 수요 폭주 → Pro 폴백:', msg.slice(0, 80));
      return await callGeminiWithKey(key, 'gemini-2.5-pro', parts, jsonMode);
    }
    throw e;
  }
}

// ── /api/parse : 루브릭 추출 (Pro, Flash 폴백) ──
app.post('/api/parse', async function(req, res) {
  try {
    var pdfBase64 = req.body.pdfBase64;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 필요' });

    var prompt =
      '당신은 교육 평가 전문가입니다. 첨부된 PDF의 채점 기준을 분석하여 루브릭을 추출하세요.\n\n' +
      '[1단계: PDF 구조 파악]\n' +
      '아래 다양한 형태 중 어떤 구조인지 먼저 파악하세요:\n' +
      '- 표(Table) 형태: 행=평가항목, 열=수준/점수 또는 행=수준, 열=항목\n' +
      '- 텍스트 서술형: 항목과 기준을 문장으로 설명\n' +
      '- 체크리스트형: 항목별 O/X 또는 이행/미이행 구조\n' +
      '- 계층형: 대항목 아래 소항목이 있는 구조\n' +
      '- 혼합형: 위 형태들이 섞인 구조\n\n' +
      '[2단계: 공통 추출 원칙]\n' +
      '구조와 관계없이 아래 원칙으로 추출하세요:\n' +
      '1. 평가 항목(name): PDF에 명시된 항목명 그대로. 계층형이면 "대항목 > 소항목" 형태로.\n' +
      '2. 배점(min/max): PDF에 명시된 값 그대로. 예외 처리:\n' +
      '   - 배점 없이 등급만(A/B/C/D): 등급 수에 따라 max를 4/3점 단위로 배분\n' +
      '   - 총점만 있고 항목별 배점 없음: 항목 수로 균등 배분\n' +
      '   - 이행/미이행(O/X)형: min=0, max=1\n' +
      '   - 배점 범위(예: 8~10점): min=8, max=10\n' +
      '3. 평가 기준(description): 항목이 평가하는 내용을 구체적으로. 항목명 단순 반복 금지.\n' +
      '4. 수준별 기술어(criteria): 상/중/하, A/B/C/D 등 수준 구분이 있으면 추출. 없으면 빈 배열([]).\n' +
      '5. 계층형이면 소항목 단위로 분리.\n\n' +
      '[3단계: 검증]\n' +
      '- totalMax가 PDF 총점과 일치하는가?\n' +
      '- 누락 항목은 없는가?\n' +
      '- min <= max 인가?\n\n' +
      '반드시 아래 JSON만 출력하세요:\n' +
      '{"rubrics":[{"name":"항목명","min":최저점숫자,"max":최고점숫자,"description":"구체적 평가 기준","criteria":[{"level":"수준명","score":점수숫자,"desc":"수준 기술어"}]}],"totalMin":최저점합계,"totalMax":최고점합계,"notes":"PDF 구조 유형 및 특이사항"}';

    var parts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt }
    ];

    var result;
    try { result = await callGemini('gemini-2.5-pro', parts, true); }
    catch (proErr) {
      console.log('Pro 모델 실패, Flash로 폴백:', proErr.message);
      result = await callGemini('gemini-2.5-flash', parts, true);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/grade : 채점 + 세특 (일반 JSON 응답) ──
app.post('/api/grade', async function(req, res) {
  try {
    var pdfBase64       = req.body.pdfBase64;
    var answerPdfBase64 = req.body.answerPdfBase64;
    var question        = req.body.question;
    var modelAnswer     = req.body.modelAnswer;
    var studentName     = req.body.studentName;
    var rubrics         = req.body.rubrics;

    if (!pdfBase64 || !rubrics || !rubrics.length)
      return res.status(400).json({ error: '필수 항목 누락' });
    if (!answerPdfBase64)
      return res.status(400).json({ error: '답안 PDF 필요' });

    var totalMax = rubrics.reduce(function(s, r) { return s + r.max; }, 0);

    var gradeGuide =
      '등급 기준 (총점 ' + totalMax + '점 기준):\n' +
      '  A+: ' + Math.round(totalMax * 0.95) + '점 이상\n' +
      '  A:  ' + Math.round(totalMax * 0.90) + '점 이상\n' +
      '  B+: ' + Math.round(totalMax * 0.85) + '점 이상\n' +
      '  B:  ' + Math.round(totalMax * 0.80) + '점 이상\n' +
      '  C+: ' + Math.round(totalMax * 0.70) + '점 이상\n' +
      '  C:  ' + Math.round(totalMax * 0.60) + '점 이상\n' +
      '  D:  ' + Math.round(totalMax * 0.50) + '점 이상\n' +
      '  F:  ' + Math.round(totalMax * 0.50) + '점 미만';

    var rubricDetail = rubrics.map(function(r, i) {
      var criteriaStr = '';
      if (r.criteria && r.criteria.length) {
        criteriaStr = '\n   수준별 기준:\n' + r.criteria.map(function(c) {
          return '   - ' + c.level + '(' + c.score + '점): ' + c.desc;
        }).join('\n');
      } else {
        criteriaStr = '\n   (수준별 기준 없음 — ' + r.min + '~' + r.max + '점 범위 내 답안 수준에 따라 부여)';
      }
      return (i + 1) + '. [' + r.name + '] ' + r.min + '~' + r.max + '점\n' +
             '   평가 기준: ' + (r.description || '') + criteriaStr;
    }).join('\n\n');

    var gradingPrompt =
      '당신은 교육 평가 전문가입니다. 첨부된 두 PDF(①채점 기준, ②학생 답안)를 분석하여 채점하세요.\n\n' +
      '[평가 대상]\n' +
      (studentName ? '학생: ' + studentName + '\n' : '') +
      (question ? '문제: ' + question + '\n\n' : '문제: ①번 PDF(채점 기준)에 포함된 문제를 참고하세요.\n\n') +
      (modelAnswer ? '[모범 답안]\n' + modelAnswer + '\n\n' : '') +
      '[채점 루브릭 — 총 ' + totalMax + '점]\n' +
      rubricDetail + '\n\n' +
      '[채점 지침]\n' +
      '1. ②번 PDF의 학생 답안 전체를 꼼꼼히 읽으세요.\n' +
      '2. 각 루브릭 항목별로 답안의 관련 내용을 찾아 대조하세요.\n' +
      '3. 수준별 기준이 있으면 해당 수준의 점수를 부여하세요.\n' +
      '   수준별 기준이 없으면 답안 완성도에 따라 min~max 범위 내에서 부여하세요.\n' +
      '4. 루브릭 기준에 엄격하게 근거하여 채점하세요. 점수를 관대하게 주지 마세요.\n' +
      '5. 점수는 반드시 각 항목의 min 이상 max 이하여야 합니다.\n' +
      '6. 피드백은 답안의 구체적 내용을 언급하며 잘한 점과 개선점을 2~3문장으로 서술하세요.\n\n' +
      gradeGuide + '\n\n' +
      '반드시 아래 JSON만 출력하세요:\n' +
      '{"rubrics":[{"name":"항목명","min":최저점,"max":최고점,"score":부여점수,"feedback":"피드백 2~3문장"}],' +
      '"total":합계점수,"totalMax":' + totalMax + ',"grade":"등급"}';

    var setechPrompt =
      '당신은 교과 담당 교사입니다. 첨부된 학생의 수행평가 답안을 바탕으로 학교생활기록부 교과 세부능력 및 특기사항(세특)을 작성하세요.\n\n' +
      '[수행평가 문제]\n' + (question || '첨부된 답안 PDF의 문제 내용을 참고하세요.') + '\n\n' +
      '[학생 답안 — 첨부 PDF 참고]\n\n' +
      '[세특 작성 원칙]\n' +
      '- 단순 활동 나열이 아닌, 답안에서 드러난 학생의 사고 과정과 역량을 교사가 포착하여 기술하세요.\n' +
      '- 성찰 역량화: 어려움은 끈기로, 흥미는 학습 호기심으로 변환하여 기술하세요.\n' +
      '- 분량: 공백 포함 500byte 이내, 한 개의 문단.\n' +
      '- 수치, 백분율(%), 괄호()와 그 내용을 모두 제외.\n' +
      '- 어미: ~함, ~보임, ~구현함 등 교사의 관찰자 시점 유지.\n' +
      '- 금지: 학생은/학생이/학생 이름 등 학생 직접 지칭.\n' +
      '- 금지: 체득함, 느꼈음, 이해함, 알게 됨, 깨달음, ~을 느낌 등 내면 묘사.\n' +
      '- 허용: 이해도가 높음, 태도가 돋보임, 역량을 발휘함 등 관찰 가능한 표현.\n' +
      '- 외래어 최소화, 동일 단어 반복 금지.\n' +
      '- 학생의 발전 가능성이 드러나도록 긍정적으로 서술.\n\n' +
      '세특 문구만 출력하세요. JSON 없이 순수 텍스트로만.';

    var gradeParts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: gradingPrompt }
    ];
    var setechParts = [
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: setechPrompt }
    ];

    // 채점 (1회 — Render 타임아웃 방지)
    var gradeResults = [];
    try {
      var r = await callGemini('gemini-2.5-flash', gradeParts, true);
      gradeResults.push(r);
    } catch (e) {
      console.log('채점 실패:', e.message);
    }
    if (!gradeResults.length) throw new Error('채점 실패');

    var gradeResult = gradeResults[0];
    gradeResult.setech = '';

    // 세특
    try {
      var setechText = await callGemini('gemini-2.5-flash', setechParts, false);
      gradeResult.setech = typeof setechText === 'string' ? setechText : '';
    } catch (e) {
      console.log('세특 작성 실패:', e.message);
      gradeResult.setech = '';
    }

    res.json(gradeResult);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/regrade : 추가 채점 (세특 없이 채점만) ──
app.post('/api/regrade', async function(req, res) {
  try {
    var pdfBase64       = req.body.pdfBase64;
    var answerPdfBase64 = req.body.answerPdfBase64;
    var question        = req.body.question;
    var modelAnswer     = req.body.modelAnswer;
    var studentName     = req.body.studentName;
    var rubrics         = req.body.rubrics;

    if (!pdfBase64 || !rubrics || !rubrics.length)
      return res.status(400).json({ error: '필수 항목 누락' });
    if (!answerPdfBase64)
      return res.status(400).json({ error: '답안 PDF 필요' });

    var totalMax = rubrics.reduce(function(s, r) { return s + r.max; }, 0);

    var gradeGuide =
      '등급 기준 (총점 ' + totalMax + '점 기준):\n' +
      '  A+: ' + Math.round(totalMax * 0.95) + '점 이상\n' +
      '  A:  ' + Math.round(totalMax * 0.90) + '점 이상\n' +
      '  B+: ' + Math.round(totalMax * 0.85) + '점 이상\n' +
      '  B:  ' + Math.round(totalMax * 0.80) + '점 이상\n' +
      '  C+: ' + Math.round(totalMax * 0.70) + '점 이상\n' +
      '  C:  ' + Math.round(totalMax * 0.60) + '점 이상\n' +
      '  D:  ' + Math.round(totalMax * 0.50) + '점 이상\n' +
      '  F:  ' + Math.round(totalMax * 0.50) + '점 미만';

    var rubricDetail = rubrics.map(function(r, i) {
      var criteriaStr = '';
      if (r.criteria && r.criteria.length) {
        criteriaStr = '\n   수준별 기준:\n' + r.criteria.map(function(c) {
          return '   - ' + c.level + '(' + c.score + '점): ' + c.desc;
        }).join('\n');
      } else {
        criteriaStr = '\n   (수준별 기준 없음 — ' + r.min + '~' + r.max + '점 범위 내 답안 수준에 따라 부여)';
      }
      return (i + 1) + '. [' + r.name + '] ' + r.min + '~' + r.max + '점\n' +
             '   평가 기준: ' + (r.description || '') + criteriaStr;
    }).join('\n\n');

    var gradingPrompt =
      '당신은 교육 평가 전문가입니다. 첨부된 두 PDF(①채점 기준, ②학생 답안)를 분석하여 채점하세요.\n\n' +
      '[평가 대상]\n' +
      (studentName ? '학생: ' + studentName + '\n' : '') +
      (question ? '문제: ' + question + '\n\n' : '문제: ①번 PDF(채점 기준)에 포함된 문제를 참고하세요.\n\n') +
      (modelAnswer ? '[모범 답안]\n' + modelAnswer + '\n\n' : '') +
      '[채점 루브릭 — 총 ' + totalMax + '점]\n' +
      rubricDetail + '\n\n' +
      '[채점 지침]\n' +
      '1. ②번 PDF의 학생 답안 전체를 꼼꼼히 읽으세요.\n' +
      '2. 각 루브릭 항목별로 답안의 관련 내용을 찾아 대조하세요.\n' +
      '3. 수준별 기준이 있으면 해당 수준의 점수를 부여하세요.\n' +
      '   수준별 기준이 없으면 답안 완성도에 따라 min~max 범위 내에서 부여하세요.\n' +
      '4. 루브릭 기준에 엄격하게 근거하여 채점하세요. 점수를 관대하게 주지 마세요.\n' +
      '5. 점수는 반드시 각 항목의 min 이상 max 이하여야 합니다.\n' +
      '6. 피드백은 답안의 구체적 내용을 언급하며 잘한 점과 개선점을  2~3문장으로 서술하세요.\n\n' +
      gradeGuide + '\n\n' +
      '반드시 아래 JSON만 출력하세요:\n' +
      '{"rubrics":[{"name":"항목명","min":최저점,"max":최고점,"score":부여점수,"feedback":"피드백 2~3문장"}],' +
      '"total":합계점수,"totalMax":' + totalMax + ',"grade":"등급"}';

    var gradeParts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: gradingPrompt }
    ];

    var gradeResult = await callGemini('gemini-2.5-flash', gradeParts, true);
    res.json(gradeResult);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('서버 실행중: http://localhost:' + PORT);
  console.log('유료 키: ' + (KEY_PAID ? '로드됨' : '없음 (FREE 키로 대체)'));
  console.log('모델: 루브릭 추출 → Pro(Flash 폴백) / 채점+세특 → Flash(Pro 폴백)');
});