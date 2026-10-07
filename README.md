# cc-sticky-notes

一個 Claude Code mod：在專案 session 裡隨口問的「為什麼 / 這是什麼」不會進主線對話，而是變成「便利貼」，在背景回答、顯示在右側 pane，並存成一棵同專案所有 session 共用的樹。主線的 context 保持乾淨，追問也能一路掛在同一條旁支下。

版本 0.0.1，給朋友試用中。設計與決策：[PLAN.md](PLAN.md)；Mods API 實測紀錄：[PROBE.md](PROBE.md)。

## 需求

- Claude Code **2.1.288 以上**（Mods 是 early access，在 2.1.288 / 2.1.289、Windows 的 Claude Desktop Code 分頁與終端機測過）。
- 選用：TypeSafe 的 Jev API key（自動分類用）、OpenAI API key（統整層可改用 OpenAI）。沒有也能用，見下方「金鑰」。

## 安裝

```bash
git clone https://github.com/k7term1a/cc-sticky-notes.git
```

**終端機**：每次啟動時帶上資料夾路徑。

```bash
claude --plugin-dir /path/to/cc-sticky-notes
```

**Claude Desktop（Code 分頁）**：在 `~/.claude/settings.json` 的 `env` 加上這個資料夾，之後開的 session 都會載入。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\cc-sticky-notes",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

- 改完要**開新的 session**（已經開著的 session 不會重新讀設定）。
- `CLAUDE_CODE_PLUGIN_DIR_WATCH` 是選用的：設了之後，mod 的檔案一更新（例如 `git pull`），開著的 session 就會自動重載。
- 裝好後在輸入框下方右側會看到 `cc-sticky-note`。打 `/sn doctor` 可以檢查金鑰有沒有讀到。

## 金鑰（選用）

建一個 `~/.claude/sticky-notes/.env`（Windows 是 `C:\Users\<你>\.claude\sticky-notes\.env`）：

```
TYPESAFE_API_KEY=apikey_...
OPENAI_API_KEY=sk-...
```

- 依序找：環境變數 → `~/.claude/sticky-notes/.env` → mod 資料夾裡的 `.env`。**不會讀你專案自己的 `.env`**（那裡常有那個專案自己的 OpenAI key）。
- 金鑰值不會被印出、記錄或存進 store；`/sn doctor` 只告訴你找到沒有、從哪裡找到。
- **沒有 Jev key**：不做自動分類，所有輸入照常進主線，不會跳任何對話框。便利貼只能用 `/sn new <問題>` 或 pane 的追問框建立。
- **沒有 OpenAI key**：完全不影響，預設本來就用 Claude（你登入的訂閱）寫標題和摘要。

## 怎麼用

### 直接在輸入框問

像平常一樣打字。Jev 判斷這句是「專案任務」還是「知識旁問」：

- **專案任務**：照常送給 Claude，什麼都不會變。
- **知識旁問**（例如「CRDT 是什麼？」）：這句不會進主線。畫面上出現一張卡片：

  ```
  A hook blocked your prompt
  Prompt dropped by a hook: cc-sticky-note：Jev 96% 判斷是旁支 → 便利貼「CRDT 是什麼？」
  ```

  幾秒後答案出現在右側 pane（會自動打開），對話裡留一行灰字預覽。灰字和卡片 Claude 都讀不到。
- **Jev 不太確定時**（信心低於 60%）：跳出「這句要進主線還是旁支？(32%)」，你選。
- **專案相關的疑問**（「為什麼我們這裡用 X？」）：照常問 Claude，並在樹上留一個書籤。

### 追問

問完一則之後，輸入框下方會顯示 `cc-sticky-note <正在追問的題目>`。這時在輸入框直接打字，Jev 會判斷是不是在延續這個話題；是的話就掛在同一條旁支下。想結束追問，按 pane 裡的「回到主線」或打 `/sn back`。

也可以在 pane 裡點任何一則便利貼，接著打字就是追問它；或用 pane 卡片裡的追問框（不經 Jev，直接掛在那一則下面）。

### 右側 pane

打 `/sn` 開關。內容：

- **便利貼**：整棵樹，追問會縮排列在下面。`●` 是這個 session 正在追問的、`◀` 是目前選中的、`…` 是還在回答、`↑` 是已回到主線的。
- **選中的那一則**：時間、誰答的（「Claude（看得到專案）」或「無專案脈絡」）、第幾層、前面幾層的一行摘要、問題與完整答案、追問框、「回到主線」。

### 指令

`/sn` 和 `/sticky-note` 完全一樣，`/sn` 比較好打。

| 指令 | 作用 |
| --- | --- |
| `/sn` | 開 / 關右側 pane |
| `/sn new <問題>` | 手動開一張便利貼（不經 Jev） |
| `/sn back` | 結束追問，回到主線 |
| `/sn feedback good` | 剛剛那句 Jev 分對了 |
| `/sn feedback bad <main\|sidebar\|followup\|project>` | 分錯了，正確應該是哪一種（也可以打「錯 主線」） |
| `/sn calibrate` | 用你標記過的資料，看各門檻下 Jev 的準確率 |
| `/sn doctor` | 檢查兩把金鑰找到沒有、從哪裡找到 |

### 幫忙測試

最有用的回饋是 **Jev 分錯的時候**：被攔成便利貼的其實是任務，或任務被當成旁問。打 `/sn feedback bad main`（或 `sidebar` 等），再截圖給我。

### 設定

下列欄位可以在 Claude Code 的設定選單（`/config`，終端機）調整：

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `autoOpenPane` | `true` | 答案回來時自動打開 pane 並選中 |
| `routeThreshold` | `0.6` | Jev 信心低於這個就問你 |
| `followupThreshold` | `0.6` | 判成追問的門檻 |
| `summaryProvider` | `claude` | 標題 / 摘要用誰寫：`claude` 或 `openai` |
| `claudeModel` / `claudeEffort` | `haiku` / `low` | 寫標題摘要的 Claude 模型與 effort（旁答本身一律用主線的模型） |
| `openaiModel` / `openaiReasoningEffort` | `gpt-5-mini` / `minimal` | `summaryProvider = openai` 時用 |

## 已知限制

- 被攔下的那句，Desktop 一定會顯示那張「A hook blocked your prompt」卡片，標題改不掉。Claude 讀不到這句，但它仍會留在本機的 session 紀錄檔裡。
- 旁答用的是主線同一個模型（Claude Code 的限制），算在你的訂閱用量裡；有 prompt cache，通常 1–3 秒。
- 剛重開或 resume 一個 session、主線還沒跑過任何回合之前，旁答拿不到專案脈絡，pane 會標「無專案脈絡」。
- Jev 會收到你最近 3 句主線 prompt 與最後一則回覆（各取前 300 字）、正在追問的題目，以及新的這句（判斷用）。介意的話不要設 Jev key。
- 便利貼存在本機：`~/.claude/plugins/store/cc-sticky-notes_*.json`。用 `--plugin-dir` 載入和正式安裝可能是不同的檔。
- 側邊欄外觀還很陽春，下一版會改。

## 開發

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -p typescript@5.6 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`，那是引擎載入 mod 時寫出來的型別（已 git-ignore），所以第一次 type-check 前要先載入一次 mod。

- `hooks/register.tsx`：所有 hook，以及 `portsOf($)`。只有這個檔碰 `$`（PROBE.md P1）。
- `hooks/tree.ts`、`route.ts`、`jev.ts`、`redact.ts`、`digest.ts`、`answer.ts`：邏輯模組，純函式或吃 `Ports`。
- `hooks/notes.ts`：流程（路由 → 便利貼 → 背景回答 → 路由樣本）。
- `hooks/feedback.ts`：路由樣本、`/sn feedback`、`calibrate`。
- `hooks/secrets.ts`：金鑰從哪裡來。
- `hooks/pane.tsx`：右側 pane 與輸入框下方的狀態列。
- `probes/m0/`：M0 探針 mod（`cc-sticky-probe`），獨立的 plugin。
