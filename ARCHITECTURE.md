# 系統架構說明

## 專案背景

本系統原為五專畢業專題，後因與**台灣師範大學特教老師**合作，經申請**國科會計畫**支持，持續擴展並正式上線服務至今。目標是為輕度智能障礙學生提供安全、友善的 AI 模擬面試練習環境，降低進入職場的門檻。

---

## 重構歷程

本系統經歷了一次完整的獨立重構，由我主導完成。

### 舊版問題

| 問題 | 說明 |
|------|------|
| 專案體積 | 17.59 GB、119,356 個檔案（含 `.venv/`、整包 Nginx 執行檔、`node_modules/` 全部提交進 repo） |
| 安全性 | OpenAI API Key、資料庫密碼明文硬寫在 `app.js` 內 |
| 可維護性 | 單一 `app.js` 高達 1,700+ 行，路由、SQL、驗證、上傳、寄信全部混在一起 |
| 可攜性 | Windows 絕對路徑硬編（如 `C:\\website\\nginx-1.27.4\\...`），無法跨環境部署 |
| 架構分散 | 多個獨立 Node app 散落在 Nginx 資料夾內，各自一份重複的 boilerplate |
| 語言 | 全部 JavaScript，無型別保護 |

### 重構成果

| 面向 | 改善內容 |
|------|----------|
| 架構 | 散落的多個 app → **pnpm workspace + Turborepo monorepo** |
| 語言 | JavaScript → **TypeScript**（全面升級） |
| 資料庫存取 | mysql2 裸 SQL + 明文帳密 → **Prisma ORM + 環境變數** |
| 後端分層 | 單檔巨型 app.js → **routes / services 分層架構** |
| 共用模組 | 各 app 重複的 DB 邏輯 → **`packages/database` 抽成共用套件** |
| 安全性 | 明文 API Key / 密碼 → **.env 環境變數管理** |
| 部署 | Windows 本機 + 硬編路徑 → **GCP 雲端 + Nginx 反向代理** |

---

## 整體架構

```
                     ┌──────────────────────────────┐
                     │       Nginx (Reverse Proxy)   │
                     │      HTTP :80 / HTTPS :443    │
                     └────────┬──────────┬───────────┘
                              │          │
           ┌──────────────────┼──────────┼──────────────────┐
           │                  │          │                   │
           ▼                  ▼          ▼                   ▼
  /  → Student App    /teacher →    /admin →         /socket.io/ →
  (Express :3000)   Teacher App   Admin App          Student App
                    (Express      (Express           (Socket.IO)
                      :5000)        :5001)
           │
           ├── REST API (/api/*)
           └── WebSocket (Socket.IO)
                    │
                    ▼
           Python subprocess
           (FER 表情分析 / 語音分析)
                    │
           ┌────────▼─────────┐
           │    MySQL 8.0     │
           │   (Prisma ORM)   │
           └──────────────────┘
```

**部署環境**：Google Cloud Platform（GCP），由我獨立完成遷雲作業（原架設於學校實體機）

**Monorepo 結構**：
```
/
├── apps/
│   ├── student/     # 學生端（Express + Socket.IO + Python）
│   ├── teacher/     # 教師端（Express）
│   └── admin/       # 管理員端（Express）
├── packages/
│   └── database/    # 共用 Prisma Client（MySQL）
└── docker/          # Nginx 設定、MySQL Docker Compose
```

---

## 技術棧

| 層級 | 技術 |
|------|------|
| 後端框架 | Express + TypeScript（三個獨立 app） |
| 專案管理 | pnpm workspace + Turborepo |
| 資料庫 | MySQL 8.0 + Prisma ORM |
| 即時通訊 | Socket.IO（WebSocket） |
| AI 出題 / 報告 | OpenAI GPT-4o |
| 表情分析 | Python · FER（MTCNN）· OpenCV |
| 語音辨識（STT） | 瀏覽器 Web Speech API（zh-TW） |
| 語音合成（TTS） | Google Cloud Text-to-Speech |
| 前端 | 原生 HTML / CSS / JavaScript · Bootstrap · TailwindCSS |
| 部署 | GCP · Nginx 反向代理 · pnpm |
| 容器化 | Docker Compose（MySQL 容器化；各 app 以 pnpm 直接運行） |

---

## AI 面試核心流程

### 題目生成（雙軌策略）

```
使用者選擇職位 + 難度
        │
        ▼
┌───────────────┐         ┌──────────────────────────────────────┐
│  簡易 / 中等  │         │               高難度                  │
│               │         │                                      │
│  教師有選定   │         │  奇數題（1,3,5,7,9）                  │
│  題組？       │         │  素材庫 → GPT-4o 生成題目             │
│  ├─ 是 → 從題組抽題    │  difficult_questions_library          │
│  └─ 否 → 資料庫隨機抽  │  → generateQuestionFromMaterial()     │
└───────────────┘         │                                      │
                          │  偶數題（2,4,6,8,10）                 │
                          │  GPT-4o 根據上一輪對話追問            │
                          │  → generateFollowUpQuestion()        │
                          │                                      │
                          │  AI 失敗時自動 fallback 至題庫        │
                          └──────────────────────────────────────┘
```

- 同一場面試內自動避免重複題目
- 高難度模式在面試開始時預先由 GPT 規劃 5 大題目類別（含必選「工作技能」）

### 即時表情分析 Pipeline

```
前端攝影機
  │ Canvas 擷取影格（每 500ms）
  │ 轉為 base64 JPEG
  ▼
socket.emit('video_frame', { interviewId, image })
  │
  ▼
Node.js (interview.socket.ts)
  │ spawn Python subprocess
  │ 以 4-byte length prefix 格式寫入 stdin
  ▼
Python (analyze.py)
  │ cv2.imdecode 解碼影格
  │ FER(mtcnn=True) 偵測表情
  │ 計算 valence / stability
  │ 輸出：confidence / anxiety / attention / engagement
  ▼
stdout → JSON per line
  │
  ▼
Node.js 接收
  │ 每 5 幀存入 DB（interviewreports）
  └── socket.emit('analysis-result') → 前端即時顯示聲音 bar
```

### 報告生成流程

```
面試結束
  │
  ▼
取得 Python 分析數據（face_score / stab_score / voice_score）
  │
  ▼
組合每題問題 + 學生回答 → GPT-4o Prompt
（角色設定：「溫暖、包容的特殊教育就業輔導員」）
  │
  ▼
GPT-4o 輸出 JSON：
  - 每題 analysis / suggestion / demo
  - 評分維度：infoExchange / engagement / linguistic（1~5）
  │
  ▼
最終分數計算：
  weightedFinalScore =
    GPT 內容分（0.5）× Python 表現分（0.5）
  │
  ▼
寫入 DB → 刪除本場 TTS 音檔 → 顯示報告頁
```

---

## 資料庫設計（主要資料表）

```
member              # 學生帳號（student_id / class_id / bcrypt 密碼）
classes             # 班級
teachers            # 教師帳號
admin               # 管理員帳號
questions           # 題目（職位 / 難度 / 題組）
question_groups     # 題組
teacher_selected_groups          # 教師選定的題組
difficult_questions_library      # 高難度出題素材庫
interviews          # 面試記錄（職位 / 難度 / 最終分數）
interviewdialogs    # 面試對話（role: user/assistant）
interviewreports    # 分析數據（face/stab/voice score）
interview_assessment             # 最終評分
interviewresponseanalysis        # 每題詳細分析
results             # DISC 人格測驗結果
personalities       # DISC 題目與解析
```

---

## 我的主要貢獻

### 開發階段
- **OpenAI API 串接**：實作 AI 面試題目生成與報告生成的完整流程（初版）
- **本地 → 外網部署**：Nginx 反向代理設定，解決多服務路徑衝突與 Socket.IO 長連線問題

### 重構階段
- **獨立完成系統重構**：17.59GB / 119,356 檔案 → 輕量 monorepo
  - JS → TypeScript 全面升級
  - 單檔巨型 app.js → routes / services 分層架構
  - 明文 API Key / DB 密碼 → 環境變數管理
  - 抽出共用 `packages/database`（Prisma）

### 維護 / 上線階段
- **遷雲**：學校實體機 → GCP（獨立完成）
- **UX 優化**：
  - 面試前朗讀須知 + 倒數計時提醒
  - 面試中即時聲音大小偵測 bar（音量視覺化，提示學生聲音狀態）
- **管理員功能**：新增 Prompt 測試介面，供台師大研究人員調整 AI 出題邏輯
- **持續維護**：Bug 修復、依合作教師需求迭代功能