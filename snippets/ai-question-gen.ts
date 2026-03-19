// ============================================================
// 雙軌出題邏輯 (Dual-Track Question Generation)
// ============================================================
// 高難度模式：
//   奇數題 → 從素材庫抽取內容，由 GPT-4o 生成面試題
//   偶數題 → GPT-4o 根據上一輪對話進行深入追問
// 簡易/中等：
//   教師有選定題組 → 從題組抽題（避免重複）
//   否則           → 資料庫隨機抽題
// 任何情況失敗     → 自動 fallback 至題庫
// ============================================================

// 檔案：apps/student/src/routes/interview.routes.ts
router.post('/generate', async (req: Request, res: Response) => {
  const { jobPosition, difficulty, messages, interviewId } = req.body;
  const numInterviewId = parseInt(String(interviewId));
  const msgList = Array.isArray(messages) ? messages : [];

  const interviewData = await prisma.interviews.findUnique({
    where: { id: numInterviewId },
    select: { voice_name: true, interview_direction: true, user_id: true },
  });
  if (!interviewData) return res.status(404).json({ error: '找不到面試記錄' });

  const { voice_name: selectedVoice = 'cmn-TW-Wavenet-A', interview_direction: interviewDirection, user_id: userId } = interviewData;

  // 題數上限：測試 3 題、簡易 7 題、其餘 10 題
  const MAX_QUESTIONS = difficulty === '測試' ? 3 : difficulty === '簡易' ? 7 : 10;
  const dbAskedCount = await prisma.interviewdialogs.count({
    where: { interview_id: numInterviewId, role: 'assistant' },
  });
  if (dbAskedCount >= MAX_QUESTIONS) {
    return res.json({ message: '面試結束，辛苦了！', audio: null, finished: true });
  }

  const currentQuestionNum = dbAskedCount + 1;

  // 防重複：同一題號已存在則跳過
  const existingQuestion = await prisma.interviewdialogs.findFirst({
    where: { interview_id: numInterviewId, role: 'assistant', question_number: currentQuestionNum },
  });
  if (existingQuestion) return res.json({ message: '正在同步題目...', finished: false });

  let nextQuestionText = '';
  let useQuestionBank = true;
  let questionFrom: 'gpt' | 'bank' = 'bank';
  const openaiKey = process.env.OPENAI_API_KEY;

  // ── 高難度：RAG 奇偶雙軌 ──────────────────────────────────
  if (difficulty === '高難度' && openaiKey) {
    try {
      const isOdd = currentQuestionNum % 2 !== 0;

      if (isOdd) {
        // 奇數題：素材庫 → GPT-4o 生成題目
        const categorySequence = interviewDirection ? JSON.parse(interviewDirection) : [];
        const currentCategory = categorySequence[Math.floor(dbAskedCount / 2)] || '工作技能';
        const material = await questionsService.getDifficultQuestionMaterial(jobPosition, currentCategory);
        if (material) {
          const generated = await questionsService.generateQuestionFromMaterial(material, openaiKey);
          if (generated) { nextQuestionText = generated; useQuestionBank = false; questionFrom = 'gpt'; }
        }
      } else {
        // 偶數題：根據上一輪對話追問
        const recentMessages = msgList.slice(-2); // 最後一問一答
        const generated = await questionsService.generateFollowUpQuestion(recentMessages, openaiKey);
        if (generated) { nextQuestionText = generated; useQuestionBank = false; questionFrom = 'gpt'; }
      }
    } catch (err) {
      console.error('❌ 高難度 AI 生成失敗，fallback 至題庫:', err);
      useQuestionBank = true;
    }
  }

  // ── 簡易/中等：教師題組 → 隨機題庫 ──────────────────────
  if ((difficulty === '簡易' || difficulty === '中等') && useQuestionBank) {
    const teacherGroupId = await questionsService.getTeacherSelectedGroup(userId, jobPosition, difficulty);
    nextQuestionText = teacherGroupId
      ? (await questionsService.getQuestionFromGroup(teacherGroupId, numInterviewId)) || ''
      : (await questionsService.getRandomQuestion(jobPosition, difficulty, numInterviewId)) || '';
    if (nextQuestionText) useQuestionBank = false;
  }

  // ── Fallback：所有方式失敗時 ──────────────────────────────
  if (useQuestionBank || !nextQuestionText) {
    const fallbackDifficulty = difficulty === '高難度' ? '中等' : difficulty;
    nextQuestionText =
      (await questionsService.getRandomQuestion(jobPosition, fallbackDifficulty, numInterviewId)) ||
      '你能再多跟我分享一些工作的細節嗎？';
    questionFrom = 'bank';
  }

  // 儲存題目、合成 TTS 語音、回傳前端
  await prisma.interviewdialogs.create({
    data: { interview_id: numInterviewId, role: 'assistant', message: nextQuestionText, question_number: currentQuestionNum, timestamp: new Date() },
  });
  const audioPath = await ttsService.synthesizeSpeech(nextQuestionText, numInterviewId, currentQuestionNum, selectedVoice);
  return res.json({ message: nextQuestionText, audio: audioPath || undefined, from: questionFrom, finished: false });
});

// ── GPT-4o 題目生成（從素材）─────────────────────────────────
// 檔案：apps/student/src/services/questions.service.ts
async generateQuestionFromMaterial(material: string, openaiKey: string): Promise<string | null> {
  const systemPrompt = `你是一位專業的面試官。請嚴格遵守以下規則：
1. 嚴禁輸出「好的」、「我明白」、「收到」等確認語。
2. 不要包含「面試官：」、「問題：」或「第 X 題」等標籤。
3. 你的回覆只能包含「面試問題內容本身」。
4. 使用繁體中文，語氣適合小學三年級程度，溫柔且鼓勵性質。`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `【素材】：${material}\n請根據素材設計一個親切的面試問題。` },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
  });

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  if (!data.choices?.[0]) return null;

  // 清除 GPT 可能輸出的多餘前綴
  let question = (data.choices[0].message?.content ?? '').trim();
  question = question.replace(/^(好的|收到|明白|面試官|問題|第[0-9一二三四五六七八九十]+題)[:：\s]*/g, '');
  return question;
}

// ── GPT-4o 追問（根據上一輪對話）────────────────────────────
async generateFollowUpQuestion(recentMessages: Array<{ role: string; content: string }>, openaiKey: string): Promise<string | null> {
  const systemPrompt = `你是一位專業的面試官。請針對面試者剛才的回答進行一次「深入追問」。
字數 30 字以內，使用繁體中文，語氣溫柔鼓勵，不要說謝謝，不要包含任何標籤或確認語。`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
      max_tokens: 100,
      temperature: 0.7,
    }),
  });

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  if (!data.choices?.[0]) return null;

  let question = (data.choices[0].message?.content ?? '').trim();
  question = question.replace(/^(好的|收到|明白|面試官|問題|第[0-9一二三四五六七八九十]+題)[:：\s]*/g, '');
  return question;
}