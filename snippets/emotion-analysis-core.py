# ============================================================
# 即時表情分析核心（Python）
# ============================================================
# 使用 FER(MTCNN) 偵測每幀的情緒分佈
# 計算：
#   valence   — 情緒正負值（加權映射七種情緒）
#   c_face    — 表情自信分（基於 valence 移動平均）
#   c_stab    — 情緒穩定分（基於 valence 標準差）
#   c_overall — 綜合自信分（face 40% + stab 30% + voice 30%）
# 每幀輸出一行 JSON 到 stdout，由 Node.js 接收
# ============================================================

# 檔案：apps/student/python/analyze.py

def calculate_valence(emotions: dict) -> float:
    """將七種情緒加權映射為單一 valence 值（-1.0 ~ 1.0）"""
    weights = {
        "happy":   1.0,
        "neutral": 0.3,
        "surprise": 0.0,
        "sad":    -1.0,
        "fear":   -1.0,
        "disgust": -1.0,
        "angry":  -0.5,
    }
    valence = sum(score * weights.get(emotion, 0) for emotion, score in emotions.items())
    return max(-1.0, min(1.0, valence))


def analyze_multimodal_confidence(current_valence: float):
    """
    根據 valence 歷史計算三個維度的自信分數：
      c_face  — 表情自信（valence 移動平均）
      c_stab  — 情緒穩定（valence 標準差，越小越穩定）
      c_voice — 語音自信（由語速/音調分析模組計算）
    最終加權：overall = face*0.4 + stab*0.3 + voice*0.3
    """
    valence_history.append(current_valence)
    if len(valence_history) > 300:  # 保留最近 300 幀
        valence_history.pop(0)

    avg_valence = np.mean(valence_history) if valence_history else 0
    c_face = clip(50 * (avg_valence + 1), 0, 100)          # 映射到 0~100

    sd_v = np.std(valence_history) if len(valence_history) > 1 else 0
    c_stab = clip(100 * (1 - sd_v), 0, 100)                # 標準差越小分數越高

    c_voice = calculate_c_voice()                           # 語音模組
    c_overall = 100 * (0.4 * (c_face/100) + 0.3 * (c_stab/100) + 0.3 * (c_voice/100))

    return c_overall, c_face, c_stab, c_voice


def analyze_images_from_stdin():
    """
    主迴圈：從 stdin 讀取影格（4-byte length prefix 格式）
    → FER 偵測情緒 → 計算各項分數 → 輸出 JSON 至 stdout
    """
    interview_id = os.environ.get('INTERVIEW_ID')
    if not interview_id:
        sys.exit(1)

    start_time = time.time()

    while True:
        # 讀取 4-byte 長度標頭
        length_bytes = sys.stdin.buffer.read(4)
        if not length_bytes:
            break
        length = int.from_bytes(length_bytes, byteorder='big')

        # 讀取影格資料
        image_data = sys.stdin.buffer.read(length)
        if not image_data:
            break

        # 解碼影格
        nparr = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None or detector is None:
            continue

        # FER(MTCNN) 情緒偵測
        emotions_list = detector.detect_emotions(frame)
        if not emotions_list:
            continue

        emotions = emotions_list[0]["emotions"]
        box      = emotions_list[0]["box"]

        # 計算各項指標
        current_valence = calculate_valence(emotions)
        c_overall, c_face, c_stab, c_voice = analyze_multimodal_confidence(current_valence)

        head_position = (box[0] + box[2] // 2, box[1] + box[3] // 2)
        movement_pct  = analyze_body_movement(head_position, time.time() - start_time)

        result = {
            "interviewId":       int(interview_id),
            "timestamp":         time.time(),
            "confidence":        round(c_overall, 2),
            "confidence_face":   round(c_face,    2),
            "confidence_stab":   round(c_stab,    2),
            "confidence_voice":  round(c_voice,   2),
            "anxiety":           round(analyze_anxiety_legacy(emotions, speech_rate_history[-1] if speech_rate_history else 160), 2),
            "attention":         round(analyze_attention(movement_pct), 2),
            "engagement":        round(analyze_engagement(emotions, pitch_variation_score_holder['score']), 2),
            "speech_rate":       round(speech_rate_history[-1] if speech_rate_history else 160, 1),
            "pitch_variation":   round(pitch_variation_score_holder['score'], 1),
            "intensity":         round(intensity_score_holder['score'], 1),
            "overall_score":     round(c_overall, 2),
        }
        print(json.dumps(result), flush=True)  # Node.js 逐行讀取