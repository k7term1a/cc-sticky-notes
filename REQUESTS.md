# 需求清單

PLAN.md 以外、之後可能做的需求。每項寫需求本身、可行性（型別檔或實測的依據）、還不知道的事、建議的探針。都還沒排進 PLAN.md；要做時再決定。

標記：✅ 實測過；📄 只看過型別檔（`.claude-plugin/types/claude-code/index.d.ts`，2.1.293），還沒實測；✗ 做不到。

---

## R1｜把選起來的文字或 code block 送到另一個對話（10/11 提出）

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
