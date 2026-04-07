const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY = process.env.GEMINI_API_KEY;
const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + KEY;

async function callGemini(parts, jsonMode) {
  var config = jsonMode ? { temperature: 0.3, responseMimeType: 'application/json' } : { temperature: 0.3 };
  var res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: parts }], generationConfig: config })
  });
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  var text = data.candidates[0].content.parts[0].text;
  if (jsonMode) return JSON.parse(text);
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

app.post('/api/parse', async function(req, res) {
  try {
    var pdfBase64 = req.body.pdfBase64;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 필요' });
    var parts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: 'PDF에서 채점 루브릭 항목을 추출하세요. 각 항목의 최저점(min)과 최고점(max)을 모두 추출하세요. 최저점이 명시되지 않은 경우 0으로 설정하세요. 점수를 임의로 변환하지 마세요. 형식: {"rubrics":[{"name":"항목명","min":최저점숫자,"max":최고점숫자,"description":"설명"}],"totalMin":최저점합계,"totalMax":최고점합계,"notes":"특이사항"}' }
    ];
    var result = await callGemini(parts, true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/grade', async function(req, res) {
  try {
    var pdfBase64 = req.body.pdfBase64;
    var answerPdfBase64 = req.body.answerPdfBase64;
    var question = req.body.question;
    var modelAnswer = req.body.modelAnswer;
    var studentName = req.body.studentName;
    var rubrics = req.body.rubrics;
    if (!pdfBase64 || !rubrics || !rubrics.length) return res.status(400).json({ error: '필수 항목 누락' });
    if (!answerPdfBase64) return res.status(400).json({ error: '답안 PDF 필요' });

    var totalMax = rubrics.reduce(function(s, r) { return s + r.max; }, 0);
    var rubricStr = rubrics.map(function(r) { return r.name + ' (' + r.min + '~' + r.max + '점)'; }).join(', ');

    var setechConditions = ''
      + '종합 피드백(overall)은 학교생활기록부 교과 세부능력 및 특기사항(세특) 형식으로 작성하세요.\n'
      + '작성 원칙:\n'
      + '- 당신은 교과 담당 교사입니다. 단순 활동 나열이 아닌, 학생이 성찰한 지점을 교사가 포착하여 역량으로 평가하는 방식으로 기술하세요.\n'
      + '- 성찰의 역량화: 어려웠던 부분은 문제 해결을 위한 끈기로, 흥미로운 부분은 학습 호기심 및 원리 이해 노력으로 변환하여 기술하세요.\n'
      + '- 분량: 공백 포함 500byte 이내, 한 개의 문단으로 작성하세요.\n'
      + '- 수치, 백분율, 괄호와 그 내용을 모두 제외하세요.\n'
      + '- 교사의 관찰자 시점을 유지하세요: ~함, ~보임, ~구현함\n'
      + '- 학생의 발전 가능성이 드러나도록 긍정적으로 서술하세요.\n'
      + '- 외래어는 필수 용어 외 지양하고, 동일 단어 반복을 피하세요.\n'
      + '- 금지 표현: 체득함, 느꼈음, 이해함, 알게 됨, 깨달음, ~을 느낌 등 관찰 불가능한 내면 묘사\n'
      + '- 허용 표현: 이해도가 높음, 태도가 돋보임, 역량을 발휘함 등 관찰 가능한 표현\n';

    var prompt = '다음 조건으로 학생 답안을 채점하고 JSON으로만 반환하세요.\n'
      + '문제: ' + question + '\n'
      + (modelAnswer ? '모범답안: ' + modelAnswer + '\n' : '')
      + '루브릭(최저~최고): ' + rubricStr + '\n'
      + '답안은 첨부된 두 번째 PDF를 참고하세요.\n'
      + '각 항목 점수는 반드시 최저점 이상 최고점 이하여야 합니다.\n\n'
      + setechConditions + '\n'
      + '형식: {"rubrics":[{"name":"항목명","min":최저점,"max":최고점,"score":부여점수,"feedback":"항목별 피드백 1-2문장"}],"total":합계점수,"totalMax":' + totalMax + ',"grade":"등급(A+/A/B+/B/C+/C/D/F)","setech":"세특 문구 (500byte 이내 한 문단)"}';

    var parts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { inline_data: { mime_type: 'application/pdf', data: answerPdfBase64 } },
      { text: prompt }
    ];
    var result = await callGemini(parts, true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('서버 실행중: http://localhost:' + PORT);
  console.log('API 키: ' + (KEY ? '로드됨' : '없음'));
});