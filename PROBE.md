# PROBE.md — M0 探針結果

2026-10-07 · branch `dev` · PLAN.md 是意圖，這份是事實；衝突處以這份為準，並列在「⚠ 偏離計畫」。

## 環境與方法

| 項目 | 值 |
| --- | --- |
| 權威型別檔 | `.claude-plugin/types/claude-code/index.d.ts`，首行 `// Written by Claude Code 2.1.288.`（載入 mod 後由引擎寫出） |
| 實測用的 Claude Code | Desktop 內建的 `2.1.288`（`%APPDATA%\Claude\claude-code\2.1.288\…\claude.exe`） |
| PATH 上的 `claude` | **2.1.283**，低於 PLAN 要求的 ≥ 2.1.287；validate / test / 探針一律改用上面的 2.1.288 |
| 探針 mod | `probes/m0/`（plugin 名 `cc-sticky-probe`，和正式 mod 分開），以 prompt 前綴 `probe-<name>` 觸發，每行結果 `$.ui.log('PROBE …')` |
| 執行方式 | `claude -p --plugin-dir probes/m0 --output-format stream-json --verbose "probe-…"`，cwd 在 scratchpad，避免在你的專案底下多出測試 session；從 stream-json 的 `ui_log` 讀結果，並直接打開 `~/.claude/projects/<cwd>/<id>.jsonl` 看 session 檔 |
| 金鑰 | `TYPESAFE_API_KEY`、`OPENAI_API_KEY` 在本機 User / Machine / 本 session 環境都**未設定**（探針以 `$.env.get` 確認，只記有無，不記值） |

**兩個阻礙**（細節在「待討論」）：
1. 獨立 CLI 的 OAuth 已過期（`Failed to authenticate: OAuth session expired and could not be refreshed`），Desktop 的登入是 host 代管的，我沒有、也不該繞過它。所以**所有要打模型的實測（fork / complete / classify 的實際回答）都沒能跑**；hook 本身在模型之前執行，不打模型的探針都有跑。
2. 沒有金鑰，Jev / OpenAI 只能驗證「端點可達、錯誤格式」，沒有成功呼叫。

標記：✅ 實測確認 · 📄 型別檔確認（未實測）· ⏳ 待補（被上面兩個阻礙或需要你肉眼看 Desktop）· ⚠ 偏離計畫

---

## 一、PLAN「風險、未知與要先驗證的事」逐題

### 1. `$.model.fork({ prompt })` 的答案會不會寫進 transcript 或 session 檔？ — 📄 不會；⏳ 實測待補

- 型別檔：`fork` 是「one tool-less completion over the session's OWN transcript as the main thread last sent it … with `prompt` after it: every tool denied, its own tail never cached」。它重送主線最後一次 request 再接上 prompt，沒有任何 append。
- `session.append` 的文件列出了引擎會寫入對話的每一種 row（prompt、command、response、tool-result…），fork 不在其中。
- 實測：只拿到 `{"isAnswered":false,"reason":"nothing-to-fork"}`（resume 的 session 只有一則 OAuth 失敗的合成 assistant 訊息，算「沒有可 fork 的回應」）。真正回答後去 grep session 檔這一步被 OAuth 擋住。
- 補充（📄）：fork 用主線**同一個 model 與 system prompt**，請求沒有 `model` 欄位，旁答不能指定較便宜的模型。

### 2. fork 能否帶 `system` 或額外 messages？ — 📄 不能 → 採 PLAN 備案

- `ModelForkRequest = { prompt: string }`，只有這一欄。
- 依 PLAN 備案，把旁支歷史串進 prompt 文字：`hooks/answer.ts` 的 `buildForkPrompt()`（前面一段 `[sticky-notes] … aside` 框架 + `[side thread so far] Q1/A1…` + `[question]`），有單元測試。

### 3. fork 在 `prompt.submit` hook 裡呼叫、該 hook 回 `{ drop }`：算不算 turn 進行中？會不會卡住？ — 📄 部分；⏳ 實測待補

- 預算：`HookBudget.ms = 10_000`，但「the clock stops while a `next(e)` call or any `$` call of the hook's is in flight（`$.clock` wait excepted）」。所以 hook 裡 await fork 不會吃預算。
- 中斷：fork 的 `aborted` 是「the turn whose hook forked was interrupted」。idle 時送出的 prompt 沒有 turn（見第 5 題，`turnId` 不存在），理論上不會被中斷。
- 沒有實測「hook 內 await fork 時 UI 是否凍住」。**正式 mod 直接採 PLAN 備案**：先回 `{ drop }`，旁答在 `$.clock.after(0, …)` 裡做（`notes.ts` 的 `startNote` → `answerNote`）。理由是使用者送出後馬上看到 drop 的提示行，不用等 2–5 秒。這不改架構。
- 注意（✅）：`-p` 模式下 hook 回 drop 後行程就結束，背景工作來不及跑。所以 headless 驗不到背景旁答，要在互動 session 驗。

### 4. `$.model.classify` 的簽名與回傳 — 📄 確認；✅ 失敗路徑實測

```ts
classify: (text: string, labels: readonly string[], options?: { model?: string }) => Promise<string | undefined>
```
- 一次 `$.model.complete`（預設 engine 的小模型）加固定分類 prompt；回傳 label 或 `undefined`；請求失敗、abort 或回覆沒有文字時 **reject**。
- 實測：`HooksError: … $.model.classify: the request failed (authentication_failed)`，確認失敗會 reject。
- **它不回傳信心值**，PLAN 的「0.6 門檻 / 校準機率」沒辦法套上去，所以不能直接取代 Jev 的 `route`。可以當「沒有 Jev key 時」的退路 → 見待討論 D3。

### 5. `prompt.submit` 的 `e` 有沒有 `turnId`？ — ✅ idle 時沒有 → 採 PLAN 備案

- 實測 `keys=text,wait,origin`、`turnId=undefined`、`origin={"kind":"sdk"}`（`-p`）；互動模式是 `composer`。
- 型別檔：`turnId` 只在「turn 進行中打字 / 投遞進該 turn」時出現。
- `turn.start` 有 `turnId`（✅ 實測 `turn.start turnId=74dc…`）。正式 mod 在 `turn.start` 記 `lastTurnId`（`$.state`），新節點的 `anchor.turnId` 用它，也就是「問這題之前主線最後一個 turn」。
- `turn.complete` 的 e：`answer,durationMs,isAborted,turnId,reason`（✅）。

### 6. hook 10 秒限制：Jev 呼叫 + 可能的 `$.ui.ask` 等待 — ✅ 安全

- 實測：`prompt.submit` 裡 `$.http.fetch('https://httpbin.org/delay/12')` 花 11,054 ms，hook 沒被判逾時，drop 照常生效。
- `$.ui.ask` 也是 `$` 呼叫，不計時（📄）。唯一會計時的是自己的程式和 `$.clock.sleep`。

### 7. `$.store` 是否跨 session、跨 `--plugin-dir` 與正式安裝共用 — ✅ 跨 session 共用；⚠ 同 key 併發會遺失寫入；⏳ 正式安裝未驗

- 實測：連續 9 個 `-p` session 的 `visits` 不斷累加，跨 session 持久。
- 檔案位置：`~/.claude/plugins/store/cc-sticky-probe_inline-cea3439ccf29.json`。把 probe 複製到另一個路徑再跑，用的仍是**同一個檔**，所以 hash 和資料夾路徑無關。
- **併發**（兩個 session 同時跑 `probe-store-race`）：
  - 不同 key：雙方都看得到對方剛寫的 key（`race:A`、`race:B` 都在），表示讀取直接讀檔、即時。
  - 同一 key 的 read-modify-write：`race-list` 最後只剩 B，A 的寫入不見了（last-writer-wins，沒有 CAS）。→ ⚠ P3
- `--plugin-dir` vs 正式安裝：檔名帶 `_inline`，推測正式安裝（marketplace）會是另一個檔、不共用。沒實際安裝驗證。→ ⚠ P5

### 8. Desktop：`AbovePrompt` 長相 / 高度、mod 的 `Pane` 能否拖曳 / 彈出、`Button.hotkey` 吃不吃 ⌥ — 部分 ✅；⏳ 視覺要你看

- `hotkey`：📄「One digit or one lowercase letter … anything else is refused」，Shift+w 等同 `"w"`。✅ 用 test kit 掛 `hotkey="⌥s"`：整棵樹被拒、引擎改畫自己的（`plugin tree drawn=false engine fallback drawn=true`）。→ ⚠ P7
  - 替代：`Button.action` 可以綁引擎既有的 keybinding action（例：`"app:cycleDiffBase"`），使用者自己設的 chord 就能從 prompt 觸發；但只能用引擎認得的 action 名稱，不能自訂 ⌥S。
- `Pane`：`$.ui.open` 的參數只有 `id, title, focus, closeOnEscape, holdToasts, rows, columns`，**沒有 `placement`**。`placement: 'dock' | 'inline'` 是 `Pane` render props 上的唯讀值，由 surface 決定（📄）。PLAN 的 `$.ui.open({ …, placement: 'dock' })` 要拿掉。→ ⚠ P7
- `AbovePrompt`：props 有 `maxRows`（fullscreen 時是 prompt 上方剩餘的列數，上限為終端機一半高）、`bodyColumns`、`isWorking`、`hasSurvey`（📄）。Desktop 的實際樣子 / 高度、pane 能不能拖曳或彈出成獨立視窗，型別檔沒寫，需要你在 Desktop 看（⏳，載入方式見文末）。

### 9. UserMessage 徽章 / `$.prompt.suggest` / 列出 live session / pane 組合鍵 / `$.ui.scroll` — 分題

**9a. `UserMessage` 能否在原訊息右側加小按鈕而不蓋掉原文** — ✅（test kit）
- `on('ui.render', { component: 'UserMessage' }, …)` 回 `<Box flexDirection="row">{await next(e)}<Button …/></Box>`，terminal 與 desktop 都通過驗證：原文還在、按鈕能按（`probes/m0/tests/ui-probe.probe.ts`）。真實 Desktop 的視覺 ⏳。
- ⚠ 但有一個資料模型缺口 → P6：被 drop 的旁問**本身不會產生 UserMessage row**，徽章只能畫在「它前一則主線 user 訊息」上。UserMessage 的 `requestId` 是 message id，而 `anchor` 目前只記 `turnId`，對不上。

**9b. `$.prompt.suggest` 的灰字在 Desktop 怎麼顯示、會不會被送出** — 📄 語意和 PLAN 想的不同；⏳ 視覺
- 型別檔：suggest 是「proposed prompt … Tab to take: taking it puts it in the box for editing」。它是**建議的下一句 prompt**，不是狀態列。使用者按 Tab（或 →）會把「正在追問：X」放進輸入框，再按 Enter 就送出了。
- 另外，輸入框有字、turn 進行中、headless 時都不會顯示（✅ `-p` 實測 `{"isShown":false}`）。→ ⚠ P8

**9c. `$.session` 能否列出同專案其他 live session 的 id 與名稱** — ✅ 不能直接列；有部分替代
- `$.session` 沒有 list 方法（📄）。
- ✅ 但 `$.tool.call({ tool: 'ListAgents' })` 從 plugin 呼叫得到，會回一段**純文字**：`Peer sessions (7): <名稱> [6b6d02] · interactive · idle · Claude Desktop session · started 14h ago …`，列的是**本機所有專案**的 live session，沒有 sessionId、沒有 cwd / 專案。
- `$.session.send` 吃 `{ sessionId }` 或 ListAgents 的名稱（📄）。我沒有實際送訊息，以免打到你正在用的 session。→ ⚠ P4

**9d. pane 能否收到 shift + 方向鍵** — 📄 Button 不行；只有 `Client` 元件可以
- hotkey 不分大小寫、不吃修飾鍵；方向鍵在 pane 裡是捲動 / 移動焦點。只有 `Client`（desktop、terminal 才有）的 `onKey` 會收到 `{ key, shift?, ctrl?, meta? }`。依 PLAN 備案，選取模式先用「選取」按鈕。

**9e. `$.ui.scroll` 能否捲主 transcript** — 📄 可以，有條件
- 「A transcript row moves only while this call answers the person's own input」：在使用者按下 pane 按鈕的 handler 裡，`$.ui.scroll({ to: <message requestId> })` 可以捲到那一則。一樣需要 message id（同 P6）。未實測。

---

## 二、M0 交付清單其餘項目

| 項目 | 結果 |
| --- | --- |
| 空 mod 載入 | ✅ `plugin validate` 通過；`-p --plugin-dir` 載入，`session.start` 執行，`.claude-plugin/types/` 被寫出 |
| `prompt.submit` 能 `{ drop }` | ✅ 能，但有副作用 → ⚠ P2 |
| fork 的回傳形狀 | 📄 `{ isAnswered: true, text, usage }` 或 `{ isAnswered: false, reason: 'api-error' (status, error) \| 'empty-reply' \| 'aborted' \| 'nothing-to-fork', usage? }`；永不 reject。`usage.cache_read_input_tokens` 表示主線 prompt cache 命中多少 |
| `$.model.complete` | 📄 `{ model, prompt, system?, maxTokens? (預設 1024，上限 64000), effort?: 'low'\|'medium'\|'high'\|'xhigh'\|'max', timeoutMs? }`，有 `system`。PLAN 的 `claudeEffort` 合法值就是這五個（已寫進 `userConfig` 的 `options`） |
| `$.http.fetch` 打 Jev | ✅ 可達：`POST https://api.typesafe.ai/v1/systemone` 無 key 回 `403 {"detail":{"error_type":"authentication_error","message":"Must supply an API key! …"}}`。⏳ 成功呼叫要 key |
| `$.http.fetch` 打 OpenAI | ✅ 可達：`GET /v1/models` 無 key 回 `401 Missing bearer authentication`。⏳ 成功呼叫要 key |
| `$.http.fetch` 回傳 | ✅ `{ status, ok, headers, text }`（headers 是小寫 key 的物件） |
| `$.session.messages()` 夠不夠做摘要 | ✅ 每則 `{ role, text, toolUses }`（user 可能另有 `toolResults`）。`text` 是 text blocks 串起來，**沒有時間戳、沒有 message id、沒有 turnId**，最多最新 4096 則。做主線摘要的文字夠用；要對應「哪一則」就不夠（P6）。`{ as: 'api' }` 可拿完整 content blocks |
| `$.session.usage()` | ✅ `{ startedAt, context: { window }, rateLimits: [], cost: { usd } }`；`-p` 下 `rateLimits` 是空的。PLAN 的「訂閱用量 %」要在互動 session 再看 ⏳ |
| `$.session.id()/root()/cwd()/version()` | ✅ 都有。`version` = `{ version: '2.1.288', base, builtAt }` |
| `userConfig` | ✅ PLAN 的格式（`type/default/description`，加上 `title`）驗證通過；string 欄位可加 `options` 變成 `/config` 裡的下拉選單（`summaryProvider`、`claudeEffort`、`openaiContextMode` 已加） |
| `-p` 的 slash command | ✅ `claude -p "/sticky-note …"` 不會被當成 plugin 指令，而是送去模型。prompt 在 `session.start` 註冊指令之前就被解析了（之後才出現 `commands_changed`）。只影響 headless，互動 session 的 `session.start` 會在第一句 prompt 前跑完（📄） |
| Jev 的 request schema | 📄（第三方）console.typesafe.ai 對 WebFetch 回 403，官方文件讀不到。`jev.ts` 用的是 apidog.com 的 Jev 介紹文：`{ model: 'jev-latest', state, questions: { <id>: { type: 'choice'\|'noul'\|'score', instructions, criteria } } }` → `{ answers: { <id>: { type, choice, confidence, probabilities } \| { type: 'noul', noul } } }`。Noul 只回一個機率、沒有 confidence。**拿到 key 後要用 Playground 對一次** |

---

## 三、⚠ 偏離計畫

每項：做不到 / 不一樣的是什麼 → 文件怎麼說 → 我的建議。除了 P1（不改就無法載入），其餘都**沒有自行改架構**，只照 PLAN 原意實作並標註。

### P1. 邏輯模組不能拿到 `$`（載入器的靜態規則）— 已用最小調整處理，請確認

- **做不到**：PLAN 的檔案分工是 `register.ts` 只做註冊，`route.ts / tree.ts / openai.ts …` 各自呼叫 `$`。載入器拒絕把 `$` 傳進 import 來的函式：
  > `$ is followed only into a function declared in this same file, never across an import; $ is always spelled $.noun.event(...) at the call site`
- 另外兩條同類規則（✅ 實測）：
  - `atom()` 只能在**使用它的同一個檔案**宣告（`the state library's update takes a source … written there or in a const of this file`）。
  - `$.env.get` / `$.env.set` 的名稱必須是字串常值。
- **可以的**（✅ 用 4 個小 plugin 驗過）：別的檔案裡 `on(...)` 註冊 hook；同檔 helper 接 `$`；把「包住 `$` 的 closure」傳過 import。
- **我做的調整**：檔案結構、職責完全照 PLAN，只改呼叫慣例。`register.ts` 有一個同檔的 `portsOf($)`，把需要的能力包成 closure（型別定義在 `hooks/ports.ts`），邏輯模組只吃 `Ports`；atom 全部宣告在 `register.ts`；`pane.tsx` 改成純 view 函式（收 element table 與 handler）。副作用是邏輯可以用純物件 fake 來測，不用整個引擎。
- **不這樣做的替代**：全部 `$` 相關程式放進 `register.ts` 一個檔，檔案會很大。我沒選。

### P2. `{ drop }` 不是完全隱形

- **不一樣**：模型確實收不到（✅ session 檔裡沒有 user row），但：
  1. 畫面上會出現一行 notice：`Prompt dropped by a hook: <reason>`，以 `system / informational`（warning level、`isMeta: false`）存進 transcript。drop 的 reason **一定會顯示給使用者**（型別檔：「The text is shown to the user as the reason」）。
  2. 原始問題文字仍留在 session 檔的 `queue-operation`（`enqueue`）紀錄（reference：「the message queue's own record of a prompt as it was queued … is no row of the conversation」）。
- 成功標準 1「主線 transcript 不出現它」：**模型的 context 是乾淨的**，但畫面上有一行提示，session 檔裡有原文。
- **建議**：把 drop reason 直接當 PLAN 要的透明度訊息（`→ 便利貼：<問題前 40 字>`），不另外再 `$.ui.log`，否則同一件事會出現兩行（目前就這樣實作）。session 檔的原文目前沒辦法避免；在意的話，以後想辦法改用 `$.prompt.read` / 其他輸入路徑。Desktop 上這行長什麼樣 ⏳。

### P3. 單一 key `tree:${root}` 在多個 live session 下會遺失寫入

- **不一樣**：PLAN 的同專案 3–4 個 live session 共用一棵樹，整棵樹存在一個 key。`$.store` 沒有 compare-and-set，同一 key 的併發 read-modify-write 是 last-writer-wins（✅ `race-list` 實測遺失一筆）。
- **目前**：照 PLAN 一個 key。`mutateTree` 把「讀」緊貼在「寫」之前，衝突窗口縮到毫秒級，但沒有消除；兩個 session 剛好同時完成旁答時仍可能掉一個節點。
- **建議**（改資料佈局，要你決定）：照 ✅「不同 key 不互相覆蓋」拆開存 → `node:<root>:<id>`（每節點一個 key）、`active:<root>:<sessionId>`（每 session 自己的 activeThread）、`outline:<root>:<id>`、`meta:<root>`（tags、mainDigest）。`roots` 改由節點的 `anchor.at` 排序推出來。`tree.ts` 的純函式不必改，只改存取層。4 MiB 是整個 store 的上限，拆 key 不影響容量估算。

### P4. 「同專案的其他 live session」列不出來

- **做不到**：沒有 `$.session.list`。`ListAgents` 從 plugin 呼叫得到，但只回一段文字，列**全部專案**的 session（名稱 + 短 ref + 狀態），沒有 sessionId 和專案。
- **建議**：mod 自己做 presence。每個 session 在 `session.start` 寫 `live:<root>:<sessionId> = { title?, startedAt, heartbeat }`（不同 key，併發安全），`$.clock.every(60s)` 更新 heartbeat，`session.end` 刪掉；「回流到 ▾」列出同 root、heartbeat 在 2 分鐘內的，再用 `$.session.send({ to: { sessionId } })` 送。session 名稱取不到，先顯示 `anchor` 裡最後一句主線前 30 字或啟動時間。（`$.session.send` 本身沒有實測送出。）

### P5. `$.store` 在 `--plugin-dir` 和正式安裝之間大概不共用

- store 檔名是 `<name>_inline-<hash>.json`，`_inline` 表示 `--plugin-dir` 來源；正式安裝推測會是別的檔。開發時存的樹，正式安裝後看不到。
- **建議**：先接受（開發資料本來就是測試用）；或在 M3 照 PLAN 的備案存 `~/.claude/sticky-notes/<hash>.json`（mod 只能透過 `$.fs` 寫，路徑要絕對）。要不要做、做在哪期，請你決定。

### P6. 主線徽章 / 捲動需要 message id，資料模型沒有

- 被 drop 的旁問不會變成 UserMessage row，徽章只能掛在它前一則主線 user 訊息上；`UserMessage` 和 `$.ui.scroll` 都用 message id（`requestId`）。`anchor` 只有 `turnId`，`$.session.messages()` 又沒有 id。
- **建議**：`Anchor` 加 `messageId: string | null`。在 `session.append` hook（`door === 'prompt'`，`next(e)` 回 `{ uuid }`）記最後一則主線 prompt 的 uuid 放進 `$.state`，建節點時寫入。這是 M2 的事，型別先不改，等你同意。

### P7. 熱鍵與 pane 位置

- `⌥S` 不能當 hotkey（只吃一個數字或小寫字母，✅ 實測被拒），PLAN 的「[開啟 ⌥S]」做不到。
- `$.ui.open` 沒有 `placement` 參數，由 surface 決定。
- **建議**：帶子的按鈕用 `hotkey="s"`（帶子或 pane 取得焦點後按 s；從 prompt 要先 ctrl+x tab），或找一個合適的引擎 keybinding action 綁 `action`。`$.ui.open` 拿掉 `placement`。

### P8. `$.prompt.suggest` 是「建議 prompt」，不是灰色狀態字

- 按 Tab 就把「正在追問：X」放進輸入框，可能被誤送；輸入框有字或 turn 進行中時根本不顯示。
- **建議**：「正在追問：X」改用 PLAN 的備案 `$.ui.status`（prompt 下方一行，每個 plugin 一個），或放在帶子裡（帶子本來就會畫）。目前骨架還留著 suggest 呼叫，等你看過 Desktop 的實際樣子再定。

---

## 四、待討論

| # | 問題 | 我目前的處理 / 預設 | 需要你決定的 |
| --- | --- | --- | --- |
| D1 | 讓模型相關探針能跑：獨立 CLI 的 OAuth 過期 | 沒跑 fork / complete / classify 的實際回答 | 在終端機跑 `claude` → `/login` 讓獨立 CLI 能用；或允許我在 Desktop session 開 hot reload 跑（會跳「Enable hot reloading」對話框，要你按）。剩下要補的探針：fork 的答案是否進 session 檔、hook 內 await fork 是否凍住 UI、classify 的品質、背景旁答在互動 session 的完整流程 |
| D2 | 金鑰 | 兩把都沒設；mod 照 PLAN 降級（缺 Jev → 問、缺 OpenAI → fork / Claude） | 設好 `TYPESAFE_API_KEY` / `OPENAI_API_KEY`（使用者環境變數；Desktop 要重啟才會繼承），我再補 Jev 與 OpenAI 的成功呼叫，並用 Jev Playground 對 schema |
| D3 | **缺 Jev 時「全部走 `$.ui.ask`」= 每一句 prompt 都跳一次對話框**，太干擾 | 照 PLAN 實作（測試也照它寫） | 建議改成：缺 Jev → 預設主線，只有 `/sticky-note new` 和 pane 追問框能建 note；或缺 Jev 時用 `$.model.classify`（沒有信心值）當退路，只有它判 `sidebar_knowledge` 才問 |
| D4 | P1 的 Ports 慣例 | 已實作，validate / tsc / test 全過 | 接受，或改成全部放進 register.ts |
| D5 | P3 的 store 拆 key | 單一 key + 縮短窗口 | 要不要在 M1 就拆 |
| D6 | 專案 key：`$.session.root()` vs `$.session.repo().root` | 照 PLAN 用 `session.root()` | `root()` 會跟著 worktree 移動。Desktop 的 session / fork 若開在 worktree，同 repo 的 session 會分成不同的樹（成功標準 4 會失敗）。`repo().root` 永遠是主 working tree。建議改用 `repo()?.root ?? root()`；改的話只動 `notes.ts` 的 `projectKey` 一行。Desktop fork 會不會開 worktree，我沒辦法在這裡驗證 |
| D7 | `needs_project_ctx` 的門檻 | PLAN 沒寫，暫定 `≥ 0.5` 走 fork（`route.ts` 的 `NEEDS_CTX_AT`） | 要不要偏保守（例如 ≥ 0.3 就走 fork，少送外部） |
| D8 | `project_question` 的「`promotedAt = now` 書籤節點」 | 只做了「`next` + context」，書籤節點留 TODO | 書籤節點要不要成為 `activeThread`（會讓下一句追問掛在它下面）？我傾向不要 |
| D9 | 整合大綱時，某個舊大綱的成員全被搬走 | 刪掉這個空大綱（`createOutline`），會回 `moved` 讓 UI 提示 | PLAN 沒說；OK 嗎 |
| D10 | `/sticky-note new <問題>` 的指令紀錄本身可能會進主線 context | 未驗證（`-p` 下指令不被辨識） | 若互動 session 驗出 slash command 的 record 會被模型讀到，`new` 就不是乾淨入口，pane 追問框才是 |
| D11 | 命名 / 結構小差異 | `Node` → `TreeNode`（避免和全域名衝突）；新增 `hooks/ports.ts`、`hooks/notes.ts`（流程編排）、`hooks/providers/types.ts`；PLAN 的 `hooks/openai.ts` 先合併進 `providers/openai.ts` | 需要的話照 PLAN 拆回 `openai.ts`（client + 用量計數）與 `providers/openai.ts`（介面實作） |
| D12 | PATH 上的 CLI 是 2.1.283 | 用 Desktop 內建的 2.1.288 | 要不要 `claude update`（README 已鎖 2.1.288） |
| D13 | UI 骨架截圖 | 骨架已做（帶子一行 + pane 列表 / 答案 / 回到主線），test kit 在 terminal 與 desktop 都驗證通過 | 我這邊沒辦法在 Desktop 載入、截圖（見下）。請你載入後看一眼，我們再對齊外觀 |

---

## 五、怎麼在 Desktop 載入看骨架（⏳ 視覺題用）

任選一種：
- 終端機：`claude --plugin-dir C:\Users\kay13\desktop\cc-sticky-notes`（存檔自動 reload）。
- Desktop：在 `~/.claude/settings.json` 的 `env` 加 `"CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\kay13\\desktop\\cc-sticky-notes"`，重開 session。（這是改你的使用者設定，所以我沒有動。）

載入後要看的：帶子（📌 Sticky Notes n · 開啟）的高度和位置、`/sticky-note` 開的 pane 在哪裡、能不能拖曳 / 彈出、drop 的提示行長怎樣、探針 mod 的 `badge-me` 徽章（另外載 `probes/m0`）。

---

## 六、程式與測試現況

- `claude plugin validate .`：✅ passed（只剩 manifest 層級的提示）
- `tsc -p .`（TypeScript 5.6，含 tests）：✅ 0 errors
- `claude plugin test .`：✅ **61 pass / 0 fail**（6 個檔）
  - `tree.test.ts`：掛接（root / 三層追問 / 點回上層長出兄弟節點 / 每 session 各自的 activeThread / 父節點不存在退成 root）、大綱（只收 root、搬移、stale、重算、刪除）、removeNode、store round-trip
  - `route.test.ts`：決策表每一列、門檻邊界、follow-up / root、fork / provider、tag、`$.ui.ask` 回答對應
  - `redact.test.ts`：code fence、路徑、長英數串、`KEY=value`、一般中文不動
  - `jev.test.ts`：state 組裝與截斷、tag 題、回應解析、無 key 不打網路、Bearer header、403 對應；title/summary JSON 解析；fork prompt 帶歷史
  - `notes.test.ts`：用 fake Ports（stub fetch / fork / complete）跑完整流程：無 key → ask、Jev 路由、note 立即寫入 + 背景回答 + 標題摘要、三層追問的歷史有帶進 fork、跨 session 共用樹但 activeThread 各自
  - `ui.test.ts`：帶子與 pane 骨架在 terminal、desktop 都能畫
- `probes/m0`：validate ✅；tsc ✅；`plugin test` ✅ 2 pass（UserMessage 徽章、⌥ hotkey 被拒；測試檔叫 `ui-probe.probe.ts`，避免被主 mod 的 `plugin test .` 一起跑到，執行方式寫在檔頭）
