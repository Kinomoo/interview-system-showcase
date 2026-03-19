// ============================================================
// 即時表情分析 Pipeline
// ============================================================
// 資料流：
//   前端攝影機（每 500ms）
//     → base64 JPEG → socket.emit('video_frame')
//     → Node.js 以 4-byte length prefix 寫入 Python stdin
//     → Python FER(MTCNN) 偵測表情
//     → 計算 valence / stability / overall confidence
//     → stdout JSON → Node.js 轉發前端 + 每 5 幀寫入 DB
// ============================================================

// 檔案：apps/student/src/sockets/interview.socket.ts

// 接收前端影格，寫入 Python stdin
socket.on('video_frame', (data) => {
  const session = activeSessions.get(socket.id);
  if (!session?.analyzeProcess) return;

  // 去除 base64 header，轉成 Buffer
  const imageData = data.image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(imageData, 'base64');

  // 以 4-byte Big-Endian length prefix 格式送入 Python stdin
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(buffer.length, 0);

  if (session.analyzeProcess.stdin && !session.analyzeProcess.stdin.destroyed) {
    session.analyzeProcess.stdin.write(lengthBuffer);
    session.analyzeProcess.stdin.write(buffer);
  }
});

// 啟動 Python 分析子程序，讀取分析結果並寫入 DB
function startAnalysisProcess(interviewId: number, socket: Socket): ChildProcess {
  const scriptPath = path.join(__dirname, '../../python/analyze.py');
  const pythonCmd = process.env.PYTHON_CMD || 'python';
  const pythonProcess = spawn(pythonCmd, [scriptPath], {
    env: { ...process.env, INTERVIEW_ID: interviewId.toString() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let analysisCount = 0;
  const rl = readline.createInterface({ input: pythonProcess.stdout });

  rl.on('line', async (line) => {
    try {
      const result = JSON.parse(line);
      socket.emit('analysis-result', result); // 即時推送前端（聲音 bar 等視覺化）
      analysisCount++;

      // 每 5 幀存一次 DB，避免過於頻繁寫入
      if (analysisCount % 5 === 0) {
        await interviewService.saveAnalysisResult({
          interviewId,
          confidence:     result.confidence      || 0,
          anxiety:        result.anxiety          || 0,
          attention:      result.attention        || 0,
          engagement:     result.engagement       || 0,
          speechRate:     result.speech_rate,
          pitchVariation: result.pitch_variation,
          overallScore:   result.overall_score    || 0,
          faceScore:      result.confidence_face  || 0,
          stabScore:      result.confidence_stab  || 0,
          voiceScore:     result.confidence_voice || 0,
        });
      }
    } catch {
      // 非 JSON 行（如 Python debug 訊息）略過
    }
  });

  pythonProcess.stderr.on('data', (data) =>
    console.error(`🐍 Python stderr: ${data.toString('utf-8')}`)
  );
  return pythonProcess;
}