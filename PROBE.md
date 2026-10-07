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

**第一輪的兩個阻礙**（10/07 上午已排除，見第〇節）：
1. 獨立 CLI 的 OAuth 已過期（`Failed to authenticate: OAuth session expired and could not be refreshed`），Desktop 的登入是 host 代管的，我沒有、也不該繞過它。所以**所有要打模型的實測（fork / complete / classify 的實際回答）都沒能跑**；hook 本身在模型之前執行，不打模型的探針都有跑。
2. 沒有金鑰，Jev / OpenAI 只能驗證「端點可達、錯誤格式」，沒有成功呼叫。

標記：✅ 實測確認 · 📄 型別檔確認（未實測）· ⏳ 待補（被上面兩個阻礙或需要你肉眼看 Desktop）· ⚠ 偏離計畫

---

## 〇之二、第三輪（10/07 中午）：決定已套用、M1 完成

用 Desktop 新內建的 **2.1.289**（`.claude-plugin/types/claude-code/index.d.ts` 首行已是 2.1.289）跑 validate / test / 探針；PATH 上的 `claude` 仍是 2.1.283。

**你的決定 → 程式位置**

| 項目 | 怎麼做的 | 位置 |
| --- | --- | --- |
| P1 Ports | 照舊 | `hooks/ports.ts`、`register.ts` 的 `portsOf` |
| P2 drop 提示 | drop reason「→ 便利貼：<前 40 字>」就是透明訊息，不另外 log | `notes.ts` `dropReason` |
| P3 拆 key | `node:<root>:<id>`、`outline:<root>:<id>`、`active:<root>:<sessionId>`、`meta:<root>`；`roots` **和每個節點的 `children`** 都在讀取時由 `parentId` 依 `anchor.at` 推出、不存。只寫有變的 key（`saveDiff`）。`children` 也不存是因為存了的話，兩個 session 同時在同一個父節點下追問，父節點那個 key 又會互蓋 | `tree.ts` |
| P4 | 回流只進目前 session；`promotedTo` → `promotedIn` | `types/index.d.ts`、`tree.ts` `markPromoted` |
| P6 | `anchor.messageId`：`session.append` door='prompt' 記 uuid（✅ 實測正確，見下） | `register.ts` |
| P7 | 帶子「開啟」`hotkey="s"`；`$.ui.open` 沒有 placement | `pane.tsx` |
| P8 | 拿掉 `$.prompt.suggest`；帶子顯示「正在追問：<title>」 | `pane.tsx` `bandView` |
| P9 (a) | fork 以外的答案在 pane 標「無專案脈絡」，`$.ui.log` 的答案行也標 | `pane.tsx` `contextMark`、`notes.ts` |
| P10 (b) | `session.append` hook 把 `/sticky-note new <問題>` 紀錄的 args 改成 `new (sticky note)`（✅ 實測） | `commands.ts` `maskNewArgs`、`register.ts` |
| D3 | 缺 Jev（沒 key、錯誤、回應壞掉）→ 全部進主線，不跳對話框 | `route.ts` `decide(null)`、`notes.ts` |
| D6 | 專案 key = `repo()?.root ?? root()` | `register.ts` `portsOf.projectRoot` |
| D7 | `NEEDS_CTX_AT = 0.3` | `route.ts` |
| D8 | `project_question` 建書籤節點（`promotedAt/promotedIn` = 當下），不成為 activeThread | `notes.ts` `bookmarkNote`、`tree.ts` `addNode(..., { makeActive: false })` |
| D15 (a) + 回饋接口 | `project_question` 的描述加了「我們 / 這裡 / 這個專案」的中英例子；另做路由回饋接口（下節） | `jev.ts`、`hooks/feedback.ts` |
| 摘要語言 | 跟著問題；中文一律繁體（✅ 實測已是繁體） | `digest.ts` `LANGUAGE_RULE`（fork / 知識旁路也加了） |
| OpenAI 推理 | `userConfig.openaiReasoningEffort`（預設 `minimal`，`none` = 不送參數） | `plugin.json`、`providers/openai.ts` |
| 缺 OpenAI key | `summaryProvider = openai` 但沒 key → 退回 Claude，toast 一次（PLAN 新規則） | `providers/types.ts` `withFallback` |
| 金鑰來源（你中途改的） | 不需要 Windows 環境變數：環境變數 → `~/.claude/sticky-notes/.env` → mod 資料夾的 `.env`；**不讀目前專案的 `.env`**。PLAN.md「金鑰」段已同步改寫 | `hooks/secrets.ts` |

**路由回饋接口（D15）**：每次 Jev 判斷記一筆 `route:<root>:<id>`（prompt 前 200 字、Jev 原始機率、當時門檻、決策、節點 id；每專案上限 500，只在本機）。標記：`/sticky-note feedback good|bad [main|sidebar|followup|project]`（中文「對 / 錯 主線 / 旁支 / 追問 / 專案」也可）、`$.ui.ask` 的選擇自動當正解、M2 的「重新分類」接 `source: 'reclassify'`。`/sticky-note calibrate` 用 `$.ui.log` 印出各門檻的「自動幾句、對幾句、要問幾成」。UI 還很陽春，之後再調。

**第三輪實測**（真實引擎、`--input-format stream-json`、**不帶任何金鑰環境變數**）

| 項目 | 結果 |
| --- | --- |
| 金鑰從檔案讀 | ✅ `/sticky-note doctor` → 兩把都「有（C:\Users\kay13\desktop\cc-sticky-notes\.env）」，查找順序 `~/.claude/sticky-notes/.env → <mod>/.env`；`/sticky-note new` 的 fork 與標題摘要都正常 |
| P10 遮罩 | ✅ session 檔裡的指令紀錄變成 `<command-args>new (sticky note)</command-args>`，對話 row 裡已沒有問題原文。佇列紀錄（`queue-operation enqueue`）仍有原文，和 P2 相同，無法避免 |
| `anchor.messageId` | ✅ 等於第一句主線 prompt 的 uuid（`53e80965…`） |
| 拆 key 後的 store | ✅ 只有 `node:<root>:<id>` 與 `active:<root>:<sessionId>` 兩個 key，節點不含 children |
| 摘要語言 | ✅ 標題「TCP流量控制」、摘要與答案皆繁體 |
| ⚠ **新：`session.messages()` 會把 slash command 紀錄當成 user 訊息** | ✅ 實測：`mainSnippet` 抓到的是 `<command-name>/sticky-note</command-name>…`。**已修**：`notes.ts` `isTypedPrompt` 排除 `<command-…>`、`<local-command-…>`、`<system-reminder>` 開頭的訊息，Jev 的 `[recent main-line context]` 也一起受惠；有測試 |
| `claudeModel` 可以設定嗎 | ✅ `$.model.complete` 接受別名（`sonnet`、`opus`）與完整 id（`claude-haiku-4-5-20251001`）。打錯名稱**不會讓 mod 壞掉**：回 `api-error 404 model_not_found`，標題退回問題前 12 字。它只管統整層（標題、摘要、知識旁路）；fork 旁答永遠用主線模型（API 限制） |

**還沒驗、需要你在 Desktop 做的**（mod 已經靠 `CLAUDE_CODE_PLUGIN_DIRS` 載入新 session；建議把 key 移到 `~/.claude/sticky-notes/.env`，或先用 repo 這份）：
1. 開新 session，打 `/sticky-note doctor`：兩把 key 都要「有」。
2. 打一句專案任務（例如「幫我看一下 README」）→ 應該直接進主線、不跳對話框。
3. 打「TCP 的 backpressure 是什麼原理？」→ 畫面只剩一行「→ 便利貼：…」，輸入框**有沒有卡住**（這就是「hook 內 await fork 的 UI 行為」；目前實作是 drop 後在背景 fork，理論上不會卡）；幾秒後出現 toast 與一行 dim 的 📌 答案。
4. 接著打「那 Node stream 的 highWaterMark 呢？」→ 看會不會掛成追問（帶子上要顯示「正在追問：…」）。
5. 打 `/sticky-note new 什麼是 CRDT` → 用 ctrl+o 看 transcript：指令那行應該是 `new (sticky note)`。
6. 看帶子（📌 Sticky Notes n · 正在追問 … · 開啟）、按 `s` 或點「開啟」開 pane、pane 的位置 / 能不能拖、drop 提示行長怎樣（D13）。
7. 隨手 `/sticky-note feedback good` 或 `bad project`，最後 `/sticky-note calibrate` 看輸出。

## 〇、第二輪實測（10/07 上午，CLI 已登入、金鑰已放進 `.env`）

第一輪被擋住的探針都補跑了。下面各題標題的狀態已同步更新；這一節是摘要和新發現。

**跑法調整**：你的 `~/.claude/settings.json` 現在用 `CLAUDE_CODE_PLUGIN_DIRS` 讓正式 mod 跟著每一個 `claude` 載入。跑探針時我加了 `--setting-sources project`，避免正式 mod 攔截 `probe-…` prompt。要讓 fork 有東西可以 fork，改用 `--input-format stream-json` 在**同一個行程**裡先跑一個正常 turn，再送探針 prompt，stdin 保持開著讓背景工作跑完。

| 項目 | 結果 |
| --- | --- |
| fork 看得到主線嗎 | ✅ 先講「codename BLUEFIN、Postgres 16」，再 fork 問 → `ZEBRA7 BLUEFIN Postgres 16`。耗時 1.0–3.0 s，`cache_read_input_tokens` ≈ 39.6k（主線 prompt cache 命中），新輸入只有 31–85 tokens |
| fork 答案會不會進 session 檔 | ✅ **不會**。三個 fork 的答案用「只出現在答案裡」的字（`hash function`、`drain`、`ZEBRA7 BLUEFIN`）grep session 檔，全部 0 筆；也沒有額外的 subagent 檔 |
| 旁支歷史串進 prompt | ✅ `fork-history` 正確接續上一題（答到 Node stream 的 `write()` 回 false / `drain`） |
| hook 裡 await fork 再 drop | ✅ 可以，hook 等了 1.0–3.0 s 才 drop，沒被判逾時（$ 呼叫不計時）。互動 session 下輸入框會不會因此卡住，要你在 Desktop 看 ⏳ |
| drop 後在 `$.clock.after(0)` 裡 fork | ✅ 背景照常答完（1.8 s），正式 mod 用的就是這條路 |
| ⚠ **新：resume 後的第一題不能 fork** | ✅ 用 `--resume` 接上一個有完整回答的 session，`session.messages()` 看得到回答，fork 卻回 `nothing-to-fork`。fork 重送的是「本行程主線最後送出的那個 request」，剛 resume、還沒跑過 turn 就沒有可重送的。→ P9 |
| `$.model.complete` | ✅ haiku、`effort: 'low'`、有 `system`：1.5 s，55 in / 96 out tokens。回覆包在 ```json fence 裡（`digest.ts` 的 parser 本來就處理） |
| `$.model.classify` | ✅ 「why does TCP need a three-way handshake」→ `sidebar_knowledge`，613 ms。沒有信心值（同第 4 題） |
| Jev 實際呼叫 | ✅ 200，`jev-1.13.0`，**回應格式和 `jev.ts` 假設的完全一致**（`answers.route.{choice, confidence, probabilities}`、`answers.is_followup.noul`）。每次約 560 input / 123 output tokens，300–600 ms |
| OpenAI 實際呼叫 | ✅ 200。⚠ `gpt-5-mini` 是推理模型：`max_completion_tokens: 400` 全被 reasoning 吃光，`content` 是空字串（`finish_reason: length`）。加上 `reasoning_effort: 'minimal'` 後 2.4 s、149 tokens、正確 JSON。M4 的 `providers/openai.ts` 要帶這個參數 |
| 正式 mod 端到端 | ✅ 正常 turn → `/sticky-note new TCP 的 backpressure 是什麼原理？` → toast `→ 便利貼：…` → 背景 fork 回答 → 自動標題摘要 → toast `📌 TCP流量控制`。store 裡的節點欄位齊全，`anchor.turnId` 是前一個主線 turn、`mainSnippet` 正確 |
| ⚠ **新：`/sticky-note new` 會把問題留在主線** | ✅ session 檔多了兩則 user row：一則 `isMeta` 的 `<local-command-caveat>…recorded here as context for later messages`，一則**非 meta** 的 `<command-name>/sticky-note</command-name>…<command-args>new TCP 的 backpressure 是什麼原理？</command-args>`。模型之後讀得到這個問題 → P10 |
| 更正：`-p` 的 slash command | 第一輪說「`-p "/sticky-note …"` 不被辨識」是**錯的**。Git Bash 的 MSYS 路徑轉換把 `/sticky-note` 改成了 `C:/Program Files/Git/sticky-note`。關掉轉換後，單發 `-p "/sticky-note back"` 正常執行 |
| 標題 / 摘要的語言 | 問題是繁體中文，haiku 寫出的摘要是**簡體**（「反压」「通过」），標題一次繁體一次簡體。`digest.ts` 的 system prompt 要明講「繁體中文」。小修，等你看完一起改 |

**Jev 對六句典型 prompt 的判斷**（state 裡 active_thread 固定是 none）：

| prompt | route | is_followup | needs_project_ctx | tag |
| --- | --- | --- | --- | --- |
| TCP 的 backpressure 是什麼原理？ | sidebar_knowledge 1.0 | 0.02 | 0.07 | network 1.0 |
| 幫我把 login.ts 的 token 輪替寫完 | main_task 1.0 | 0.13 | 0.92 | __new__ 0.84 |
| 為什麼我們這裡用 session cookie 而不是 JWT？ | **sidebar_knowledge 0.65** | 0.16 | 0.69 | __new__ 0.81 |
| 好，就照你說的改 | main_task 1.0 | 0.10 | 0.62 | __new__ 0.93 |
| 那 Node stream 的 highWaterMark 又是什麼？ | sidebar_knowledge 0.99 | 0.03 | 0.09 | __new__ 0.96 |
| what is the difference between pipe and pipeline in node | sidebar_knowledge 1.0 | 0.04 | 0.08 | __new__ 0.99 |

第三句計畫書會期待 `project_question`，Jev 給 `sidebar_knowledge` 0.65，剛好過 0.6 門檻，會被 drop 進旁支（因為 ctx 0.69，答題走 fork）。這正是 M1 驗收要用 50 句真實 prompt 校正的地方，也可以考慮把 `project_question` 的描述寫得更具體。

**金鑰的三件事**（沒有動你的 `.env`）：
1. **兩把 key 放反了**：`TYPESAFE_API_KEY` 的值是 `sk-…` 開頭（OpenAI 的格式），`OPENAI_API_KEY` 是 `apikey_…`。照原樣兩邊都回 401；對調後兩邊都 200。
2. `.env` 是 CRLF 換行、值有加引號。用 shell `source` 的話，第一行的值後面會多一個 `\r`。我的測試腳本是自己 parse（去掉 `\r` 和引號、對調兩個值）再丟給子行程。
3. **mod 本身不讀 `.env`**，計畫書規定只從環境變數拿（`$.env.get`）。Desktop 啟動的 session 不會自動載入 repo 裡的 `.env`。→ 待討論 D14

## 一、PLAN「風險、未知與要先驗證的事」逐題

### 1. `$.model.fork({ prompt })` 的答案會不會寫進 transcript 或 session 檔？ — ✅ 不會（第〇節）

- 型別檔：`fork` 是「one tool-less completion over the session's OWN transcript as the main thread last sent it … with `prompt` after it: every tool denied, its own tail never cached」。它重送主線最後一次 request 再接上 prompt，沒有任何 append。
- `session.append` 的文件列出了引擎會寫入對話的每一種 row（prompt、command、response、tool-result…），fork 不在其中。
- 實測：只拿到 `{"isAnswered":false,"reason":"nothing-to-fork"}`（resume 的 session 只有一則 OAuth 失敗的合成 assistant 訊息，算「沒有可 fork 的回應」）。真正回答後去 grep session 檔這一步被 OAuth 擋住。
- 補充（📄）：fork 用主線**同一個 model 與 system prompt**，請求沒有 `model` 欄位，旁答不能指定較便宜的模型。

### 2. fork 能否帶 `system` 或額外 messages？ — 📄 不能 → 採 PLAN 備案，✅ 實測可用

- `ModelForkRequest = { prompt: string }`，只有這一欄。
- 依 PLAN 備案，把旁支歷史串進 prompt 文字：`hooks/answer.ts` 的 `buildForkPrompt()`（前面一段 `[sticky-notes] … aside` 框架 + `[side thread so far] Q1/A1…` + `[question]`），有單元測試。

### 3. fork 在 `prompt.submit` hook 裡呼叫、該 hook 回 `{ drop }`：算不算 turn 進行中？會不會卡住？ — ✅ 不會逾時、背景版也可行；⏳ 互動時 UI 是否卡住

- 預算：`HookBudget.ms = 10_000`，但「the clock stops while a `next(e)` call or any `$` call of the hook's is in flight（`$.clock` wait excepted）」。所以 hook 裡 await fork 不會吃預算。
- 中斷：fork 的 `aborted` 是「the turn whose hook forked was interrupted」。idle 時送出的 prompt 沒有 turn（見第 5 題，`turnId` 不存在），理論上不會被中斷。
- 沒有實測「hook 內 await fork 時 UI 是否凍住」。**正式 mod 直接採 PLAN 備案**：先回 `{ drop }`，旁答在 `$.clock.after(0, …)` 裡做（`notes.ts` 的 `startNote` → `answerNote`）。理由是使用者送出後馬上看到 drop 的提示行，不用等 2–5 秒。這不改架構。
- 注意（✅）：`-p` 模式下 hook 回 drop 後行程就結束，背景工作來不及跑。所以 headless 驗不到背景旁答，要在互動 session 驗。

### 4. `$.model.classify` 的簽名與回傳 — 📄 確認；✅ 成功 / 失敗都實測

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
| `$.http.fetch` 打 Jev | ✅ 無 key 回 403、錯 key 回 401 `Cannot authenticate with the server`、正確 key 回 200（第〇節） |
| `$.http.fetch` 打 OpenAI | ✅ 無 key 401、錯 key 401 `invalid_api_key`、正確 key 200（第〇節；注意 reasoning token） |
| `$.http.fetch` 回傳 | ✅ `{ status, ok, headers, text }`（headers 是小寫 key 的物件） |
| `$.session.messages()` 夠不夠做摘要 | ✅ 每則 `{ role, text, toolUses }`（user 可能另有 `toolResults`）。`text` 是 text blocks 串起來，**沒有時間戳、沒有 message id、沒有 turnId**，最多最新 4096 則。做主線摘要的文字夠用；要對應「哪一則」就不夠（P6）。`{ as: 'api' }` 可拿完整 content blocks |
| `$.session.usage()` | ✅ `{ startedAt, context: { window }, rateLimits: [], cost: { usd } }`；`-p` 下 `rateLimits` 是空的。PLAN 的「訂閱用量 %」要在互動 session 再看 ⏳ |
| `$.session.id()/root()/cwd()/version()` | ✅ 都有。`version` = `{ version: '2.1.288', base, builtAt }` |
| `userConfig` | ✅ PLAN 的格式（`type/default/description`，加上 `title`）驗證通過；string 欄位可加 `options` 變成 `/config` 裡的下拉選單（`summaryProvider`、`claudeEffort`、`openaiContextMode` 已加） |
| `-p` 的 slash command | ✅ **更正**：可以正常執行。第一輪的「不被辨識」是 Git Bash 把 `/sticky-note` 轉成 Windows 路徑造成的（第〇節） |
| Jev 的 request schema | ✅ 實際呼叫的回應和第三方文章描述的格式一致（`jev-1.13.0`）；`jev.ts` 不用改 |

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

### P9. resume 之後、跑第一個主線 turn 之前，fork 沒有東西可以 fork

- **不一樣**：PLAN 假設 fork 隨時能拿「當下主線上下文」。實測 fork 只重送**本行程**主線最後送出的 request：剛開的 session、`/clear` 之後，以及 **resume / 重開 Desktop 之後還沒跑過 turn** 時，都回 `nothing-to-fork`（文件寫的「a resume that starts the conversation afresh」）。
- **目前**：`answer.ts` 遇到 `nothing-to-fork` 就改走統整層供應者（不帶專案脈絡），節點的 `answeredBy` 會記成 `claude` / `openai`，不是 `claude-fork`。
- **建議**：保留這個退路，另外二選一：(a) 在 pane 上標「無專案脈絡」；(b) 這種情況改用 PLAN 第 1 題的備案：`$.model.complete` + `$.session.messages()` 最近 N 則自己組 prompt（沒有 prompt cache，比較貴，但有脈絡）。

### P10. `/sticky-note new <問題>` 會把問題留在主線 context

- **不一樣**：PLAN 把它當「手動入口」，暗示和 Jev 路由一樣乾淨。實測 slash command 的紀錄（`<command-args>new <問題></command-args>`）是一則非 meta 的 user row，模型之後讀得到，只多了一段「這是使用者自己跑的指令」的 caveat。
- **建議**：(a) 接受：問題本身很短，答案不會進主線；(b) 用 `session.append` hook 把這則 row 的 `<command-args>` 改寫成 `new (sticky note)`（文件允許改寫 text block，型別上可行，沒實測）；(c) 手動入口只保留 pane 的追問框。我傾向 (b)，請你決定。

## 四、待討論

> 10/07 中午：下表第一、二輪的項目你都已決定，套用情形見第〇之二節。目前沒有新的待決項目；只剩上面「需要你在 Desktop 做的」檢查，以及兩個風險先記著：
> - **讀取量**：拆 key 之後每次載入樹要對每個節點各呼叫一次 `$.store.get`（每次 prompt 路由前、每次寫入前都會載入）。幾十個節點沒感覺；PLAN 估的上千節點時會不會變慢，還沒量。若變慢，M3 可以加「只在 session.start 與 pane 開啟時全量載入，其餘只讀寫單一節點」。
> - **金鑰檔位置**：我選了 `~/.claude/sticky-notes/.env` 當正式位置、mod 資料夾的 `.env` 當開發位置，不讀專案 `.env`。要換位置只改 `secrets.ts` 的 `keyFiles`。

| # | 問題 | 我目前的處理 / 預設 | 需要你決定的 |
| --- | --- | --- | --- |
| D1 | ~~讓模型相關探針能跑~~ | ✅ 已解決（CLI 已登入），結果見第〇節 | 只剩互動 session 的 UI 卡頓 / 視覺 |
| D2 | 金鑰 | `.env` 裡兩把 key 放反了，對調後兩邊都 200（第〇節） | 把 `.env` 的兩個值對調 |
| D3 | **缺 Jev 時「全部走 `$.ui.ask`」= 每一句 prompt 都跳一次對話框**，太干擾 | 照 PLAN 實作（測試也照它寫） | 建議改成：缺 Jev → 預設主線，只有 `/sticky-note new` 和 pane 追問框能建 note；或缺 Jev 時用 `$.model.classify`（沒有信心值）當退路，只有它判 `sidebar_knowledge` 才問 |
| D4 | P1 的 Ports 慣例 | 已實作，validate / tsc / test 全過 | 接受，或改成全部放進 register.ts |
| D5 | P3 的 store 拆 key | 單一 key + 縮短窗口 | 要不要在 M1 就拆 |
| D6 | 專案 key：`$.session.root()` vs `$.session.repo().root` | 照 PLAN 用 `session.root()` | `root()` 會跟著 worktree 移動。Desktop 的 session / fork 若開在 worktree，同 repo 的 session 會分成不同的樹（成功標準 4 會失敗）。`repo().root` 永遠是主 working tree。建議改用 `repo()?.root ?? root()`；改的話只動 `notes.ts` 的 `projectKey` 一行。Desktop fork 會不會開 worktree，我沒辦法在這裡驗證 |
| D7 | `needs_project_ctx` 的門檻 | PLAN 沒寫，暫定 `≥ 0.5` 走 fork（`route.ts` 的 `NEEDS_CTX_AT`） | 要不要偏保守（例如 ≥ 0.3 就走 fork，少送外部） |
| D8 | `project_question` 的「`promotedAt = now` 書籤節點」 | 只做了「`next` + context」，書籤節點留 TODO | 書籤節點要不要成為 `activeThread`（會讓下一句追問掛在它下面）？我傾向不要 |
| D9 | 整合大綱時，某個舊大綱的成員全被搬走 | 刪掉這個空大綱（`createOutline`），會回 `moved` 讓 UI 提示 | PLAN 沒說；OK 嗎 |
| D10 | `/sticky-note new` 的指令紀錄會進主線 | ✅ 已驗證會進 → P10 | P10 選 (a)/(b)/(c) |
| D11 | 命名 / 結構小差異 | `Node` → `TreeNode`（避免和全域名衝突）；新增 `hooks/ports.ts`、`hooks/notes.ts`（流程編排）、`hooks/providers/types.ts`；PLAN 的 `hooks/openai.ts` 先合併進 `providers/openai.ts` | 需要的話照 PLAN 拆回 `openai.ts`（client + 用量計數）與 `providers/openai.ts`（介面實作） |
| D12 | PATH 上的 CLI 是 2.1.283 | 用 Desktop 內建的 2.1.288 | 要不要 `claude update`（README 已鎖 2.1.288） |
| D13 | UI 骨架截圖 | 骨架已做（帶子一行 + pane 列表 / 答案 / 回到主線），test kit 在 terminal 與 desktop 都驗證通過 | 我這邊沒辦法在 Desktop 載入、截圖（見下）。請你載入後看一眼，我們再對齊外觀 |
| D14 | mod 怎麼拿到金鑰 | PLAN：只從環境變數（`$.env.get`）。repo 裡的 `.env` 不會被 Desktop / `claude` 自動載入，所以現在 Desktop 裡跑的正式 mod 拿不到 key，會走「缺 Jev → 每句都問」（D3） | (a) 把兩把 key 設成 Windows 使用者環境變數（`setx`，重開 Desktop），維持 PLAN；(b) 讓 mod 在 `session.start` 用 `$.fs.read` 讀專案根目錄的 `.env`（和 PLAN「不寫進任何檔案」的精神衝突；`.env` 已加進 `.gitignore`）。我建議 (a) |
| D15 | 「為什麼我們這裡用 session cookie」被判 sidebar 0.65 | 照 PLAN 門檻 0.6 會被 drop | M1 校正時一起處理，或先在 `project_question` 的描述裡加「提到『我們 / 這裡 / 這個專案』」的例子 |

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
- `claude plugin test .`：✅ **78 pass / 0 fail**（7 個檔，第三輪；新增 `feedback.test.ts`：回饋解析 / 上限 / 校正、P10 遮罩、金鑰檔順序；`tree.test.ts` 新增拆 key 的併發測試）
  - `tree.test.ts`：掛接（root / 三層追問 / 點回上層長出兄弟節點 / 每 session 各自的 activeThread / 父節點不存在退成 root）、大綱（只收 root、搬移、stale、重算、刪除）、removeNode、store round-trip
  - `route.test.ts`：決策表每一列、門檻邊界、follow-up / root、fork / provider、tag、`$.ui.ask` 回答對應
  - `redact.test.ts`：code fence、路徑、長英數串、`KEY=value`、一般中文不動
  - `jev.test.ts`：state 組裝與截斷、tag 題、回應解析、無 key 不打網路、Bearer header、403 對應；title/summary JSON 解析；fork prompt 帶歷史
  - `notes.test.ts`：用 fake Ports（stub fetch / fork / complete）跑完整流程：無 key → ask、Jev 路由、note 立即寫入 + 背景回答 + 標題摘要、三層追問的歷史有帶進 fork、跨 session 共用樹但 activeThread 各自
  - `ui.test.ts`：帶子與 pane 骨架在 terminal、desktop 都能畫
- `probes/m0`：validate ✅；tsc ✅；`plugin test` ✅ 2 pass（UserMessage 徽章、⌥ hotkey 被拒；測試檔叫 `ui-probe.probe.ts`，避免被主 mod 的 `plugin test .` 一起跑到，執行方式寫在檔頭）
