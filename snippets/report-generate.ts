// ============================================================
// 面試報告生成 + 加權分數計算
// ============================================================
// 流程：
//   1. 取得 Python 表情/語音分析數據（face / stab / voice score）
//   2. 組合每題問答 → 送 GPT-4o 生成詳細評估報告（JSON）
//      角色設定：「溫暖、包容的特殊教育就業輔導員」
//   3. 計算 GPT 內容分（infoExchange / engagement / linguistic）
//   4. 加權合併：最終分數 = GPT內容分(50%) + Python表現分(50%)
//   5. 寫入 DB，刪除本場 TTS 音檔
// ============================================================

// 檔案：apps/student/src/routes/interview.routes.ts
router.post('/generateReport', async (req: Request, res: Response) => {
  const { jobPosition, difficulty, interviewId: rawInterviewId } = req.body;
  const interviewId = parseInt(String(rawInterviewId));

  // 取得 Python 分析數據（若無則建立預設值）
  let analysisData = await interviewService.getAnalysisReport(interviewId);
  if (!analysisData) {
    await interviewService.createDefaultReport(interviewId, {
      face_score: 75.0, stab_score: 80.0, voice_score: 70.0,
      overall_score: 75.0, confidence: 75.0,
    });
    analysisData = await interviewService.getAnalysisReport(interviewId);
  }
  if (!analysisData) return res.status(500).json({ success: false, message: '無法取得分析報告' });

  // Python 加權分數：表情 40% + 穩定 30% + 語音 30%
  const c_face  = parseFloat(String(analysisData.face_score  || 75.0));
  const c_stab  = parseFloat(String(analysisData.stab_score  || 80.0));
  const c_voice = parseFloat(String(analysisData.voice_score || 70.0));
  const pythonOverallScore = (c_face * 0.4) + (c_stab * 0.3) + (c_voice * 0.3);

  // 取得學生每題回答
  const limit = difficulty === '測試' ? 3 : difficulty === '簡易' ? 7 : 10;
  const userResponses = await interviewService.getUserResponses(interviewId, limit);
  if (userResponses.length === 0)
    return res.status(404).json({ error: '未找到用戶回答，無法生成報告' });

  // 組合 GPT-4o Prompt
  // 角色：「溫暖、包容的特殊教育就業輔導員」
  // 輸出：純 JSON，含每題 analysis / suggestion 及三個評分維度
  const analysisText =
    `- 表情自信：${c_face.toFixed(1)}%\n` +
    `- 情緒穩定：${c_stab.toFixed(1)}%\n` +
    `- 語音自信：${c_voice.toFixed(1)}%\n` +
    `- 辨識表現分：${pythonOverallScore.toFixed(1)}%`;

  const prompt =
    `你是一位溫暖、包容的「特殊教育就業輔導員」。你的評分對象是「輕度智能障礙的學生」。\n` +
    `請根據以下資訊產出純 JSON 評估報告。\n\n` +
    `【面試情境】\n- 應徵職位：${jobPosition}\n- 難度：${difficulty}\n- 系統辨識數據：${analysisText}\n\n` +
    `【學生面試回答】\n` +
    userResponses.map(r =>
      `第 ${r.questionNumber} 題\n- 題目：${r.questionText}\n- 學生回答：${r.content}`
    ).join('\n');

  // 呼叫 GPT-4o 生成報告
  const openaiKey = process.env.OPENAI_API_KEY;
  const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
      temperature: 0.5,
    }),
  });

  const reportData: any = await openAIResponse.json();
  // 清除可能的 ```json ``` 包裝後解析
  const reportContent = reportData.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const reportJson = JSON.parse(reportContent);
  const detailedArr = reportJson.detailedAnalysis;

  // 計算 GPT 內容分（三個維度各 1~5 分 → 轉換為百分制）
  const safeCount = detailedArr.length || 1;
  const avgInfo       = detailedArr.reduce((s: number, i: any) => s + (Number(i.infoExchange) || 1), 0) / safeCount;
  const avgEngagement = detailedArr.reduce((s: number, i: any) => s + (Number(i.engagement)   || 1), 0) / safeCount;
  const avgLinguistic = detailedArr.reduce((s: number, i: any) => s + (Number(i.linguistic)   || 1), 0) / safeCount;
  const rawAvg = (avgInfo + avgEngagement + avgLinguistic) / 3;
  const gptContentScore = Math.round(rawAvg * 20); // 1→20, 3→60, 5→100

  // 最終加權分數：GPT 內容 50% + Python 表現 50%
  const weightedFinalScore = parseFloat(
    ((gptContentScore * 0.5) + (pythonOverallScore * 0.5)).toFixed(1)
  );

  // 寫入 DB
  await interviewService.saveAssessment({
    interviewId,
    infoExchangeScore: avgInfo,
    engagementScore:   avgEngagement,
    linguisticScore:   avgLinguistic,
    totalScore:        gptContentScore,
  });
  await interviewService.updateReportRecommendations(interviewId, reportJson.overallEvaluation);
  await interviewService.saveDetailedAnalysis(interviewId,
    detailedArr.map((item: any) => ({
      questionNumber: item.questionNumber,
      responseText:   '',
      analysis:       `<strong>【分析】：</strong>${item.analysis}`,
    }))
  );
  await interviewService.updateFinalScore(interviewId, weightedFinalScore);

  // 清除本場 TTS 音檔（節省儲存空間）
  await ttsService.deleteInterviewAudio(interviewId);

  return res.status(200).json({ success: true, message: '報告生成成功', reportContent });
});