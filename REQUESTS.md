# 需求清單

PLAN.md 以外、之後可能做的需求。每項寫需求本身、可行性（型別檔或實測的依據）、還不知道的事、建議的探針。都還沒排進 PLAN.md；要做時再決定。

標記：✅ 實測過；📄 只看過型別檔（`.claude-plugin/types/claude-code/index.d.ts`，2.1.293），還沒實測；✗ 做不到。

---

## R1｜把選起來的文字或 code block 送到另一個對話（10/11 提出）

> **10/14 探針結果**（PROBE.md〇之七）：選取文字 ✗（Desktop 回傳 null）；`$.prompt.fill` ✅；`$.session.send` 在 auto 權限模式下被擋（判斷器沒給結論），待重測；`$.store` 當 session 名單 ✅。

### 需求

在 Desktop 的對話裡選一段文字，或挑一個 code block，送到另一個 session。最好能指定送到哪個專案的哪個對話。

### 可行性

| 環節 | 結論 | 依據 |
| --- | --- | --- |
| 拿到選起來的文字 | 📄 Desktop 大概拿不到 | `$.ui.selection()` 回傳選取的文字與所在的對話列，但型別檔寫「`undefined` … where none is seen: fullscreen off, -p, a surface that answers none」，看起來只支援終端機全螢幕 |
| 拿到 code block | 📄 可以 | `ui.render` 的 `AssistantMessage` 拿得到每段回覆的 markdown 原文（`text`），mod 可以從裡面切出 code block，在旁邊畫一顆「傳到…」按鈕。Desktop 會請 mod 畫 `AssistantMessage`（PROBE.md〇之五，ui-demo 的 G） |
| 不靠滑鼠 | 📄 可以 | 指令，例如 `/sn send`：從 `$.session.messages()` 找上一則回覆的最後一個 code block 送出 |
| 送到另一個對話 | 📄 有正式 API | `$.session.send({ to: { sessionId }, text })`，回傳 `{ isDelivered }`，沒送到時附原因。`sessionId` 可以是這台電腦的 session，或 Remote Control / 雲端的 `session_...` id。收件方沒在跑就不會送達 |
| 列出可以送的對話 | 📄 要自己做 | 沒有「列出所有 session」的 API。做法：每個載入這個 mod 的 session 在 `session.start` 時，在共用的 `$.store` 寫一筆報到（session id、專案路徑、標題、最後活動時間），送出時讀這份名單，用 `$.ui.ask` 讓你選專案與對話。只列得到這台電腦上、有載入這個 mod、還在跑的 session |
| 收到的那一邊 | 📄 兩種 | 訊息先經過收件方的 `session.receive`（`origin.kind` 是 `peer`，`origin.plugin` 是送的 mod 名）。(a) 收件方的 mod 攔下來（`{ consumed }`），用 `$.prompt.fill` 放進輸入框當草稿，你看過再送；(b) 不攔，Claude 會當成另一個 session 傳來的訊息處理。傾向 (a)：不會打斷對方正在跑的工作 |

### 還不知道

1. Desktop 上 `$.ui.selection()` 是不是真的回傳 undefined。
2. Desktop 的 code session 之間 `$.session.send` 送不送得到；收件方畫面上長什麼樣子。
3. 在 `AssistantMessage` 旁加按鈕，Desktop 會不會照畫、會不會影響原本的排版與複製。
4. `$.prompt.fill` 在 Desktop 的輸入框有沒有效。

### 探針（還沒做）

在 dev 加暫時的 `/sn probe-send`：記下 `$.ui.selection()` 的結果；在每段回覆的第一個 code block 旁畫「傳到…」；按下後列出 `$.store` 名單、送到你選的 session；收件方記下 `session.receive` 的 `e` 並試 `$.prompt.fill`。開兩個不同專案的 Desktop session 各跑一次。

---

## R2｜輔助遠端操作（10/11 提出）

> **10/14 探針結果**（PROBE.md〇之七）：手機和筆電都不以畫面接上，mod 畫不到；遠端看得到的只有**指令輸出**與 **`$.ui.ask`**。RC4 轉圈只在筆電出現，手機不會。方向 3（手機專用版面）做不到；方向 1（遠端指令包）用指令輸出回傳。

### 需求

不在跑 session 的那台電腦前面時（用手機，或用另一台筆電透過 Remote Control），mod 能幫上忙：知道狀況、能下指令、少被卡住。

### 已知（PROBE.md「Remote Control」）

- ✅ 另一台電腦的 Claude Desktop 透過 Remote Control 打開 session 時，**不會**加入 surface 名單（沒有 `session.attach`，`$.session.surfaces()` 裡沒有它），也從來沒請 mod 畫任何東西。所以 mod 自己畫的東西（狀態列、pane、toast、`$.ui.log` 灰字、drop 卡片）全都只在跑 session 的那台。
- ✅ 能到遠端的只有 `$.ui.ask` 的對話框（問題文字 300 字內不截斷），但遠端作答後會一直轉圈（RC4）。
- ✅ 遠端送來的 prompt 和 slash 指令都是 `origin.kind = 'bridge'`。
- ✅ 現在的行為：遠端 prompt 不跳便利貼對話框，會問的句子一律進主線（commit `69fc3a6`）。
- 📄 型別檔說手機 App 打開 session 時會以 `mobile` 加入 surface 名單、請 mod 畫東西。和上面另一台筆電的結果不同，**手機還沒測**。

### 和遠端有關的 hook 與方法

**分辨是不是遠端**

| 名稱 | 說明 |
| --- | --- |
| `prompt.submit` 的 `e.origin.kind` | `'bridge'` 是遠端打的字或 slash 指令，`'composer'` 是本機。✅ 已在用 |
| `session.receive` 的 `e.origin.kind` | 送進 session 的東西在排隊前先經過這裡；`'bridge'` 是遠端。可以改寫或攔下（`{ consumed }`） |
| `config.set` 的 origin | 從遠端下的 `/config key=value` 標成 `'bridge'`，型別檔特別註明「not attestably the owner's hand」 |
| `session.model` 的來源 | 從遠端換模型歸在 `sdk`（「headless set_model (SDK, Remote Control, IDE)」） |
| `session.attach` / `session.detach` | 遠端畫面 client（手機、Desktop App）接上或離開時觸發，帶 `surface`、`clientId`、`viewport`。只能觀察 |
| `$.session.surfaces()` | 目前有哪些畫面在畫這個 session：`terminal`、`desktop`、`mobile`、`vscode` |
| `ui.render` 的 `e.surface` | 每次畫的時候知道是畫給哪一種畫面，可以給手機畫不同版本 |

**送東西到遠端**

| 名稱 | 說明 |
| --- | --- |
| `$.ui.ask` | ✅ 到得了 Remote Control 的另一台；有 RC4 轉圈問題 |
| 手機的元件 | 📄 `mobile` 能畫 `Box`、`Text`、`Button`、`Svg`、`Link`、`Code`、`Markdown`；**沒有** `Input`、`Select`；不能開 pane（型別檔：手機回報不放 pane） |
| `turn.complete` | 📄 回合結束時觸發，可以在答案下方多畫一行（例如 TL;DR）。遠端看不看得到要測 |
| `$.ui.copy({ surface: 'mobile' })` | 📄 把文字放到手機的剪貼簿 |
| `$.http.fetch` | 📄 mod 可以自己打外部服務。例如回合結束、要你批准工具、出錯時，推播到手機（ntfy、Telegram bot 之類，要你自己有帳號與 key）。這條不經過 Remote Control，任何手機都收得到 |
| `$.session.send` | 📄 送一段文字到另一個 session，`sessionId` 可以是 Remote Control 或雲端的 id |

**從遠端控制**

| 名稱 | 說明 |
| --- | --- |
| mod 的 slash 指令 | ✅ 從遠端下的 `/sn …`、`/sticky-note …` 會跑在 A 上。mod 能做的事都可以包成指令從遠端觸發 |
| `$.turn.abort` | 📄 停掉正在跑的回合 |
| `$.session.compact` + `session.compact` hook | 📄 遠端沒辦法 rewind；可以用壓縮模擬「回到某一句之前」（自己回傳截斷的訊息）。檔案改動不會復原 |
| `tool.check` | 📄 決定工具能不能執行。可以做「遠端時只放行唯讀工具」這類規則，但這是權限設定，要很小心 |
| `$.ui.ask` | 遠端要你選擇時唯一確定能用的互動方式 |

### 可能的做法（等你挑）

1. **遠端指令包**：`/sn status`（現在在做什麼、跑多久、用了多少 context）、`/sn stop`（`$.turn.abort`）、`/sn rewind <n>`（壓縮模擬）、`/sn last`（上一則回覆的純文字摘要）。輸出要能在遠端看到，可能得走 `$.ui.ask` 或指令本身的輸出，要測。
2. **手機推播**：用 `$.http.fetch` 把「回合結束」「等你批准」「出錯」推到手機。不依賴 Remote Control 畫不畫 mod 的東西。
3. **手機專用版面**：手機如果真的以 `mobile` 接上，便利貼可以給手機畫一個不用 pane 的版本（只用 `Markdown`、`Button`）。
4. **遠端便利貼**：遠端的旁問現在一律進主線。等 1 或 3 能用之後，可以再考慮讓遠端也能收成便利貼。

### 還不知道

1. 手機 App 打開 session 時，會不會以 `mobile` 觸發 `session.attach`、請 mod 畫東西（和另一台筆電的結果不同）。
2. 從遠端下 mod 指令時，指令的輸出遠端看不看得到。
3. `turn.complete` 多畫的那行在遠端看不看得到。
4. RC4（`$.ui.ask` 後遠端一直轉圈）有沒有辦法避開。

### 探針（還沒做）

在 dev 加暫時的 `/sn probe-remote`：記下 `session.attach` / `detach`、`$.session.surfaces()`、每次 `ui.render` 的 `e.surface`；讓 `/sn probe-remote out` 試三種輸出（指令輸出、`turn.complete` 多一行、`$.ui.ask`）。手機與另一台筆電各跑一次，看各自看得到什麼。

---

## R3｜收成便利貼後，主線不要留下「A hook blocked your prompt」卡片（10/12 提出）

### 需求

確定收成便利貼之後，主線對話裡那張 hook 卡片不直觀。想法是自動 rewind，讓卡片不要留在主對話頁面。

### 可行性

| 做法 | 結論 | 依據 |
| --- | --- | --- |
| 不用 `{ drop }` 也能不進主線 | ✗ | `prompt.submit` 的結果只有兩種：送進去（`{ text }`），或 `{ drop: reason }`。hook 不呼叫 `next` 就等於 drop，畫面一定顯示原因 |
| 攔下那一列，不存進對話 | ✗ | `session.append` 只能改一列的內容；型別檔：「Only a plugin's own append (door `note`) may be refused」，引擎自己的列不能拒絕 |
| 改掉卡片的標題 | ✗ | 「A hook blocked your prompt」和「Prompt dropped by a hook:」是 Desktop 自己的字（PROBE.md〇之五）；mod 只能改後面的 reason |
| 用壓縮模擬 rewind，把那一列拿掉 | ✗（10/12 更正） | `session.compact` 的 `messages` 只有 `user` / `assistant` 兩種（`SessionMessage.role`），drop 留下的是引擎的提示列，不在清單裡，壓縮動不到它。被 drop 的那句本來就沒進模型的 context，主線 context 已經是乾淨的，卡片只是畫面上的紀錄 |

### 建議

不做自動 rewind（壓縮動不到那張卡片）。能做的是讓卡片的 reason 更像「已收成便利貼」而不像錯誤（現在是「cc-sticky-note：新的便利貼「…」」，已經很短）。要的話可以加一個探針確認：壓縮後 Desktop 那張卡片會不會消失、cache 實際多花多少。

---

## R4｜主線摘要與專案整體脈絡（10/13 提出）

> **10/14 已實作**：`digestEvery` 預設 3（`/sn every <n>` 調整、0 關閉），回合結束後背景執行；`/sn provider claude|openai` 切換供應者；`/sn ctx` 與 pane 的「專案脈絡」卡片看與編輯。實作在 `hooks/context.ts`。順手補上 OpenAI 的 `redacted` 剝除（之前是 TODO，沒有真的剝）。

### 需求

現在送給 Jev 的是原文片段（主線最近 3 句的前 300 字、Claude 最後一則回覆的前 300 字、目前追問的便利貼）。改成：

- **A. 主線摘要**：用 LLM 把「上一版摘要 + 最近 3 輪問答」整合成 200 字內的摘要（現在在做什麼、剛決定了什麼、還卡在什麼），取代給 Jev 的原文片段。每個 session 一份。
- **B. 專案整體脈絡**：和 A 同一次呼叫，順便抽出這回合值得長期記住的事（決定、慣例、限制、踩過的坑），每次 0–3 條，不重複。每個專案一份，所有 session 共用。只增不減，由你微調。

### 已決定（10/13）

- B 的用途：**給 Jev 看**，以及**在 pane 與 `/sn ctx` 顯示**。暫不用在壓縮與新 session 開場。
- B 的新增方式：**直接加入**，你事後用 `/sn ctx rm <n>` 刪；`/sn ctx add <文字>` 手動加。

### 待決定

- **更新頻率**（牽涉額度）：每回合結束（約 2–4k token / 回合，haiku）、每 N 回合、或送 Jev 前才算（多等 1–3 秒）。
  - 額度的選項：統整層設 `summaryProvider = openai` 時改用 OpenAI 免費額度（gpt-5-mini，經 `openaiContextMode` 剝除），不吃 Claude 訂閱。
  - 也可以做成 userConfig（例如 `digestEvery`，0 = 關閉），由你隨時調。

### ⚠ 偏離計畫

- PLAN 成功標準 8：「除了每節點的標題與摘要之外，會花額度的動作全部由我按下去才發生」。A、B 是自動花額度的工作。
- PLAN 的 `mainDigest` 原本是 M4、手動 `/sticky-note refresh` 更新；這裡改成自動。
- 確定後 PLAN.md 的成功標準 8、統整層工作表、Jev 分類設計一起改。

---

## R5｜透過 Notion 共享便利貼（10/13 提出）

> **10/14 探針結果**（PROBE.md〇之七）：`$.tool.list()` 看得到 claude.ai Notion connector 的工具（`notion-create-pages` 等），mod 用得到；實際寫入還沒測。

### 需求

不是要在 Notion 上看，而是讓便利貼可以透過 Notion 分享給別人。

### 可行性

- 📄 `$.mcp.call(server, tool, args)` 可以呼叫 /mcp 列出的任何 server，包括 claude.ai 的 connector（例如 `claude.ai Notion`），用引擎自己的連線與授權，mod 不用放 token，也不會跳權限詢問。
- 📄 也可以用 `$.http.fetch` 直接打 Notion API，但要另外放 integration token（和 Jev 金鑰一樣讀檔）。
- 做法：`/sn share`（或 pane 按鈕）把選中的便利貼，或一整串追問，寫成一頁 Notion 頁面，回傳連結。本機 `$.store` 仍是正本。
- 注意：fork 回答的答案可能帶到專案細節，分享前要讓你看過內容。

### 還不知道

Desktop session 裡 mod 呼叫 claude.ai connector 是否可行、Notion connector 的工具名稱與參數。探針：`$.mcp.call` 建一頁測試頁。

---

## R6｜追問不是目前這張的便利貼；對話框的「其他」有用途（10/14 提出，已實作）

### 需求

想接著問的便利貼常常不是目前追問中的那張；對話框裡的「其他」原本打什麼都等於送進主線。

### 做法（A + B + C，commit 見 git log）

- **C**：送 Jev 時多問一題 `continues`：「這句延續最近哪一張便利貼？」，選項是最近 8 張（activeThread 排第一）加 `none`。同一次呼叫，不多花錢。對話框第一個選項換成 Jev 選的那張；Jev 選 `none` 時才用 activeThread。
- **A**：還有其他便利貼時，第四個選項〔接在其他便利貼下…〕，再跳一個對話框列出最多 4 張（依 Jev 的機率排序）。
- **B**：兩個對話框的「其他」都當關鍵字搜尋便利貼的標題與問題；找不到就送進主線並跳提示。

### 還不知道

Jev 對中文、8 個選項的 `continues` 準確度。回饋紀錄還沒記 Jev 選了哪張、你最後接在哪張；要校正時再加。
