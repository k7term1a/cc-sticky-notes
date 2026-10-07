# cc-sticky-notes：Claude Code Mod 計畫書

Oct 6, 2026 · @楷奇

## 背景與目標

做一個 Claude Code mod「cc-sticky-notes」（GitHub repo 與 plugin name 都是 `cc-sticky-notes`，slash command 是 `/sticky-note`），讓我在專案 session 裡隨時問「為什麼 / 這是什麼原理」而不污染主線上下文，問過的東西自動存成樹、畫在側邊 pane；同時用 OpenAI 免費額度在背景做上下文統整（主線進度摘要、旁支摘要、索引、digest）。

**要解決的痛點**

- 現在想問底層知識只能 `/branch` 或開 side chat：前者讓 session 越開越多、事後找不到；後者紀錄不穩定。
- 好奇心會一路追問，追問內容混進專案對話，佔 context window 也干擾 Claude 對任務的理解。
- 想法發散成心智圖，需要能回顧「我在專案哪個階段好奇了什麼」。

**成功標準（M4 完成時）**

1. 在主線打一句知識性問題，Claude 的 context 不出現它（畫面上只有一行「→ 便利貼：…」的提示），答案在 pane 出現，延遲小於 5 秒。
2. 連續追問三層，每層都掛在同一條旁支下；中途回到專案任務再問新問題，Jev 會開新 root 而不是接到舊旁支；點回某個節點再問，會在它底下多一個子節點。
3. 點 pane 上任一節點後，直接在主 prompt 框打字就是追問它，答案出在 pane；主線一樣乾淨。
4. 同一專案開幾個 session 都看同一棵樹（fork 的、為了 context 長度重開的、不同 worktree 的都算）；每個 session 各自記自己正在追問哪個節點；兩個 session 同時寫入不會互相蓋掉。
5. 選幾個 root 按「整合」，統整層產出一個大綱分組；大綱只有一層，不能再被整合。
6. 旁支結論能一鍵回流進目前這個 session；要帶進另一個 session，就在那個 session 開 pane、點同一個節點、回流。
7. 統整層預設走 Claude 訂閱（`$.model.complete`，可選模型與 effort），裝了就能用；設定 `summaryProvider = openai` 可改走 OpenAI 免費額度，兩條路功能相同。
8. 不論哪個供應者，除了每節點的標題與摘要之外，會花額度的動作全部由我按下去才發生；OpenAI 超過 cap 就暫停並詢問。
9. 沒有 Jev key 時所有輸入都進主線，只有 `/sticky-note new` 和 pane 追問框能建 note；不會跳對話框問我。

## 核心概念

三個設計決定，實作時遇到取捨以此為準。

**1. 旁支是便利貼，不是分支。** 旁支不複製專案對話，只是一串 Q/A 紀錄存在 `$.store`。每次追問都用 `$.model.fork` 以「當下的主線上下文 + 這條旁支的 Q/A 歷史」重新發問。因此旁支永遠看到最新專案狀態，不存在過時副本，也不需要 Claude 每個 session 重讀文件。樹上「掛在 turn T2」只是書籤，記錄當時好奇的脈絡。

```
主線  ──T1──T2──T3──T4──T5──T6──→   唯一真相，持續推進
          │          │
          ├ 旁支A    ├ 旁支B
          │ Q1→A1    │ Q1→A1
          │ Q2→A2 ←── 追問時基底是 T6 的主線 + A 的 Q1/A1
```

**2. 路由軸與標籤軸分離。** 路由（這句 prompt 進主線、進旁支、還是追問）是小而固定的集合，分錯會改變行為，交給 Jev 用預設類別判斷。標籤（這個旁支關於什麼主題）是開放詞彙，分錯只是 pane 裡放錯資料夾，由既有標籤清單 + LLM 命名慢慢長出來。不要在第一天設計完整分類法。

**3. 持久知識不進樹。** 專案時程、環境規範、架構決定這類長期有效的東西屬於 CLAUDE.md 或專案文件，Claude 本來就會讀。樹只收短命的「我好奇一下」。旁支裡得出的持久結論用「回流主線」按鈕送回，再由 Claude 或我決定要不要寫進 CLAUDE.md。

**4. 大綱是分組，不是節點。** 樹的結構從頭到尾只有一種：root 和它底下的追問鏈。大綱是蓋在 root 上面的一層分組，有自己的標題和 OpenAI 寫的摘要，成員只能是 root，一個 root 最多屬於一個大綱，大綱不能再被整合。刪掉大綱什麼都不會壞。

**5. 花錢的動作由我按，供應者可換。** 統整層（標題、摘要、大綱、主線摘要、標籤整理）走哪個模型是一個設定：預設 Claude 訂閱，因為裝了就能跑、不用多一把 key；我自己會切到 OpenAI 免費額度。不論哪個，除了每個節點產生時那一次標題 + 摘要（約 1–2k token）之外，整合大綱、更新主線摘要、合併標籤、匯出筆記全是手動，按鈕上先顯示預估 token。

**6. Pane 是導航，打字留在原地。** 點 pane 上的節點只是把它設成「目前追問中」，接著在主 prompt 框打字就會被 Jev 判成追問、攔進旁支。不用在兩個輸入框之間切換。

**不做的事**：不自動呼叫 `/branch`，也不猜使用者是不是在規劃、要不要 fork——「一個 session 做事、一個 session 規劃」是 Desktop 原生 fork 的事，mod 只負責讓兩邊共用同一棵樹；不把旁支全文注入 context；不讓 OpenAI 回答需要專案脈絡的旁問（這類題交給 `$.model.fork`）；OpenAI 額度用完不自動改用 Claude 方案額度；`openaiContextMode = off` 時任何含專案內容的工作都不出門。

## 系統架構

一句 prompt 的生命週期：

```
使用者輸入（主 prompt 框）
   │
   ▼
prompt.submit hook
   │  1. $.http.fetch 呼叫 Jev：route / is_followup / needs_project_ctx / tag
   │     state 裡帶本 session 的 activeThread（使用者剛在 pane 點的節點）與主線脈絡摘要
   │  2. 信心 < 門檻 → $.ui.ask 問使用者（主線 / 新 note / 追問）
   ▼
┌─ main ──────────► next(e)，原樣送進主線
│
├─ sidebar ───────► return { drop }，主線不收到
│                    │
│                    ├ is_followup = true  → 掛在 activeThread 底下（同一個父節點可以有多個子節點）
│                    └ is_followup = false → 開新 root
│                    │
│                    ├ needs_project_ctx = true  → $.model.fork({ prompt: 旁支歷史 + 問題 })
│                    └ needs_project_ctx = false → 統整層供應者直接回答（只送問題與旁支歷史）
│                    │
│                    ▼
│                  寫入 $.store（節點、父節點、anchor、標籤）
│                  自動：統整層供應者取標題 + 三句摘要（約 1–2k token）
│                  $.ui.invalidate 重繪 pane、主線該輪 UserMessage 加徽章
│
└─ ask ───────────► $.ui.ask 讓使用者選 main / sidebar

統整層供應者（summaryProvider）
   ├ claude（預設）：$.model.complete，吃使用者的 Claude 訂閱；claudeModel / claudeEffort 可調
   └ openai：$.http.fetch 打 OpenAI；redact、每日 cap、用量條只在這個模式生效

手動入口（不經 Jev）：/sticky-note new <問題>、pane 裡的追問框、「重新分類」按鈕

手動、按了才花額度（按鈕先顯示預估 token）
   ├ 選 N 個 root →「整合」→ 大綱分組（title + outline + memberIds）
   ├「重算大綱」：成員有新追問後手動更新
   ├「更新主線摘要」/ /sticky-note refresh → tree.mainDigest
   ├「合併標籤」
   └ /sticky-note digest / export → .claude/sticky-notes/ 底下的 .md

openai 模式超過每日 cap → 該類動作暫停 + toast，問使用者「等 UTC 00:00 重置」或「這次改用 Claude 訂閱」
```

**用到的 Mods 事件**

| 事件 | 用途 |
| --- | --- |
| `session.start` | 註冊 `/sticky-note` 指令、載入 `$.store` 的樹、開 pane（若上次有開） |
| `prompt.submit` | 路由攔截點。回 `next(e)`、`next({...e, context})` 或 `{ drop }` |
| `turn.start` / `turn.complete` | 記錄目前主線 turnId，新節點掛在這裡 |
| `ui.render`（`Pane`） | 畫樹與追問輸入框 |
| `ui.press` / `ui.input` / `ui.select` | pane 的按鈕、輸入、選節點 |
| `prompt.context` | 注入標題索引（M3 才做） |
| `command.run` | `/sticky-note` 開關 pane、`/sticky-note promote` 等 |

**用到的 Mods API**

| API | 用途 |
| --- | --- |
| `$.http.fetch` | 呼叫 Jev `POST /v1/systemone`、OpenAI chat completions |
| `$.model.fork` | 需要專案上下文的旁問；走 prompt cache，答案不進 transcript |
| `$.model.complete` | 備案：fork 不接受額外歷史時，用 haiku + 旁支歷史；也用來取標題 |
| `$.store` | 樹的持久化，跨 session 共用，上限 4 MiB |
| `$.session.messages()` / `$.session.id()` | 給 Jev 的最近對話摘要、主線 session id |
| `$.prompt.submit({ text, asUser: true })` | 「回流主線」按鈕 |
| `$.ui.open` / `$.ui.invalidate` / `$.ui.log` / `$.ui.toast` / `$.ui.ask` | 介面 |
| `$.env.get` | 讀取 `TYPESAFE_API_KEY`、`OPENAI_API_KEY` |

**三個模型的分工**

| 角色 | 模型 | 負責 | 不負責 |
| --- | --- | --- | --- |
| 分類 | Jev（TypeSafe） | 路由、是否追問、是否需專案上下文、標籤選擇 | 寫任何文字 |
| 旁答（需專案脈絡） | Claude，`$.model.fork`，走使用者的訂閱 | 看得到專案全部脈絡的旁問 | 分類、摘要 |
| 統整層，預設 | Claude，`$.model.complete`，走使用者的訂閱；`claudeModel`（預設 `haiku`）、`claudeEffort`（預設 `low`）可調 | 自動：每節點標題 + 三句摘要、`__new__` 時取標籤名。手動：整合大綱、重算、主線摘要、合併標籤、digest / export。以及不需專案脈絡的知識旁路 | 需要專案脈絡的旁問 |
| 統整層，選配 | OpenAI 免費額度（小模型組，如 gpt-5-mini），`summaryProvider = openai` | 和上面完全相同的工作清單 | 需要專案脈絡的旁問；`openaiContextMode = off` 時任何含專案內容的工作 |

M0 實測註記：`$.model.fork` 只接受 `{ prompt }`，不能指定模型或 system，旁答永遠用主線同一個模型；旁支歷史直接串進 prompt 文字。所以旁答的成本和主線一樣，便宜的只有統整層。

## 統整層與模型供應者

統整層負責所有「寫字整理」的工作：標題、摘要、大綱、主線摘要、標籤整理、匯出，以及不需專案脈絡的知識旁路。它背後的模型是一個設定 `summaryProvider`，兩個值功能完全相同：

| 值 | 怎麼打 | 誰適合 | 額外設定 |
| --- | --- | --- | --- |
| `claude`（預設） | `$.model.complete({ model, effort, system, prompt })`，走使用者登入的 Claude 訂閱，不需要 API key | 裝了就能用的人；不想多管一把 key | `claudeModel`（預設 `haiku`；可填 `sonnet`、`opus` 或完整 model id）、`claudeEffort`（預設 `low`；`$.model.complete` 支援的值以本機型別檔為準） |
| `openai` | `$.http.fetch` 打 OpenAI chat completions | 有開資料分享換每日免費額度的人（我） | `openaiModel`、`openaiContextMode`、`openaiDailyTokenCap`；需要 `OPENAI_API_KEY` |

實作上 `digest.ts` 只呼叫一個 `summarize(job, input)` 介面，`providers/claude.ts` 與 `providers/openai.ts` 各自實作；切換供應者不改任何業務邏輯。兩個供應者共用同一份工作清單和同一套「自動 / 手動」規則。

**統整工作清單**

| 工作 | 自動 / 手動 | 輸入 | 輸出 | 估算 token |
| --- | --- | --- | --- | --- |
| 節點標題 + 三句摘要 | 自動，節點建立後 | 問題 + 答案（經 redact） | `title` ≤ 12 字、`summary` | 1–2k |
| 新標籤命名 | 自動，Jev `tag` 選到 `__new__` 時 | 問題、標題、既有標籤清單 | 一個標籤名 | < 1k |
| 整合大綱 | 手動，pane 選取模式 →「整合 N 個」 | 各成員 root 的 title + summary + 第一層追問的 summary | `Outline { title, outline, memberIds }` | 每成員約 1–2k |
| 重算大綱 | 手動，大綱列的「重算」 | 同上，含新增的追問 | 更新 `outline`，清掉 `staleSince` | 同上 |
| 主線進度摘要 | 手動，`/sticky-note refresh` 或 pane 按鈕 | 上次摘要 + 之後的主線 user prompt 與 assistant 回覆（經 redact） | ≤ 200 字，存 `tree.mainDigest` | 5–15k |
| 合併相近標籤 | 手動，pane「整理標籤」 | 全部標籤 + 各自節點數 | 「A 併入 B」清單，確認後套用 | 1–3k |
| digest / export | 手動，`/sticky-note digest` `export` | 該大綱或該標籤下所有 Q/A | `.claude/sticky-notes/digests/<slug>.md`、`tree-YYYY-MM-DD.md` | 依內容 |

每顆會花錢的按鈕在按下前顯示預估 token（以字數 ÷ 2 粗估即可），`/sticky-note stats` 看今日累計。

**`openaiContextMode`**（只在 `summaryProvider = openai` 時生效；決定哪些內容可以送出 Anthropic 以外的地方）

| 模式 | 送給 OpenAI 的內容 | 統整工作怎麼跑 |
| --- | --- | --- |
| `off` | 只有知識旁路的問題與旁支歷史 | 全部改用 `$.model.complete`（haiku），吃我的方案 |
| `redacted`（預設） | 主線 user prompt 與 assistant 回覆的文字，經規則剝除：code block 整段、看起來像路徑的 token（含 `/` 或 `\` 且有副檔名）、長度 ≥ 20 的連續英數字串（疑似金鑰 / hash）、`.env` 風格的 `KEY=value` | 全部走 OpenAI |
| `full` | 原文 | 全部走 OpenAI |

`redacted` 的剝除規則放在 `redact.ts`，要有單元測試；M4 驗收時攔截真實 payload 人工看一遍。

**預算（openai 模式）**：`openaiDailyTokenCap` 預設 2,000,000（Tier 1–2 小模型組額度 2,500,000 的 80%）；用量存 `$.store` 的 `openaiUsage:<UTC 日期>`，UTC 00:00（台灣早上 8 點）歸零。超過 cap → 所有 OpenAI 動作暫停、`$.ui.toast` 一次；按鈕變灰並顯示「額度已滿，xx 小時後重置」。使用者可以在 `$.ui.ask` 裡選「這次改用 Claude 訂閱」逐次放行，不自動切換，也不留永久開關。自動的標題 + 摘要在 cap 之後改用節點問題前 12 字當標題、不產摘要，等額度回來再補。claude 模式沒有 cap，但 pane 用量條改顯示 `$.session.usage().rateLimits` 的訂閱用量百分比。

**透明**：每次統整層呼叫都 `$.ui.log('<provider>: <工作名> · <tokens> tokens')`，openai 模式再加 `mode=<contextMode>`；pane 底部顯示今日用量條。

## 資料模型

全部存在 `$.store`，以專案根目錄（`$.session.root()`）為 key 隔離不同專案。

```ts
// $.store 佈局：拆成多個 key，因為 $.store 沒有 compare-and-set，同一 key 的併發 read-modify-write 是 last-writer-wins（M0 實測掉寫入）；
// 不同 key 之間互不覆蓋、讀取即時。<root> = 專案 key = $.session.repo()?.root ?? $.session.root()，同 repo 不同 worktree 共用一棵樹。
//   node:<root>:<id>              → TreeNode
//   outline:<root>:<id>           → Outline
//   active:<root>:<sessionId>     → string | null   每個 session 自己的「目前追問中」
//   meta:<root>                   → { version: 2, tags: string[], mainDigest: {...} | null }
//   openaiUsage:<UTC 日期>        → number
// roots 不另外存，由 parentId === null 的節點依 anchor.at 排序推出來。

// 一般節點：唯一的樹結構，root → 追問鏈；一個節點可以有多個子節點，深度不限
interface TreeNode {
  id: string                   // crypto.randomUUID()
  parentId: string | null      // null = root
  outlineId: string | null     // 只有 root 會被設；指向所屬大綱，最多一個
  anchor: {                    // 書籤：好奇發生在主線哪裡
    sessionId: string          // 哪個 session 問的
    turnId: string | null      // 問這題之前主線最後一個 turn（turn.start 記下）；idle 時送出的 prompt 本身沒有 turnId
    messageId: string | null   // 前一則主線 user 訊息的 uuid（session.append door='prompt' 記下）；UserMessage 徽章與 $.ui.scroll 都靠它（M2）
    at: number                 // epoch ms
    mainSnippet: string        // 當時主線最後一句 user prompt，前 120 字；pane 不顯示，除錯用
  }
  question: string
  answer: string
  answeredBy: 'claude-fork' | 'claude' | 'openai' | 'manual'
  title: string                // ≤ 12 字，統整層取；額度滿時退化成問題前 12 字
  summary: string | null       // 三句，統整層取；回流與整合大綱都只用這個，不用全文
  tags: string[]
  route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual' }  // confidence 只給校正門檻看
  promotedAt: number | null    // 回流的時間，null = 未回流
  promotedIn: string | null    // 在哪個 session 回流的
  children: string[]
}

// 大綱：蓋在 root 上面的分組，不是樹的一部分，沒有父子
interface Outline {
  id: string
  title: string
  outline: string              // 統整層寫的摘要：各子題結論與彼此關係
  memberIds: string[]          // 只能放 root 的 id
  createdAt: number
  staleSince: number | null    // 任一成員之後有新追問就設值，pane 顯示「可重算」
}
```

**規則**

- **新 root 由 Jev 決定**：`is_followup = false`（或本 session 沒有 `activeThread`）→ `parentId = null`，本 session 的 `activeThread = 新 id`。
- **追問掛在目前節點下**：`is_followup = true` → `parentId = active:<root>:<sessionId>`，`activeThread = 新 id`。
- **一個節點可以長出多個子問題**：點回某個較上層的節點再問，新節點就掛在它底下、和既有子節點並列。
- 使用者在 pane 點選某節點 → 本 session 的 `activeThread` 改成該節點。「回到主線」設回 `null`。`project_question` 的書籤節點不會成為 `activeThread`。
- 整合大綱：只接受 root；已屬於別的大綱的 root 會被搬過來（UI 提示）；成員被搬光的舊大綱直接刪除；大綱本身不能被選取。
- 成員之後有新追問 → 該大綱 `staleSince = now`，不自動重算。
- 回流只送 `title + summary`，不送全文，目標是目前這個 session（`$.prompt.submit({ asUser: true })`）。不做跨 session 傳送：樹本來就是共用的，要帶進另一個 session 就到那邊開 pane、點同一個節點、回流。
- 跨 session：節點、大綱各自一個 key，兩邊同時寫不互蓋；`activeThread` 每 session 一份；`anchor.sessionId` 區分來源，pane 可篩「只看本 session」。

**容量**：`$.store` 上限 4 MiB。單節點估 2 KB，約可存 2,000 節點。M3 加「封存」：超過 1,500 節點時把最舊的 roots 匯出到 `.claude/sticky-notes/archive-YYYY-MM.json` 再從 store 移除。

**索引檔**（M3）：每次樹有變動，同步寫 `.claude/sticky-notes/index.md`，內容只有 `- [title] (tags) — YYYY-MM-DD` 一行一節點。這份是給人翻和給 `prompt.context` 注入用的，不是給 Claude 讀全文。

## Jev 分類設計

一次呼叫 `POST https://api.typesafe.ai/v1/systemone`（確切路徑與欄位名以 console.typesafe.ai 的文件和 Playground 為準），平行問四題。選項名稱與描述用英文，state 保持原文。

**state**（送給 Jev 的內容）

```
[recent main-line context]
<最近 3 則 user prompt + 最近 1 則 assistant 回覆，各截 300 字>

[sidebar state]
active_thread_title: <activeThread 的 title 或 none>
active_thread_last_question: <最後一題或 none>
main_turns_since_last_sidebar: <整數>

[new prompt]
<使用者剛輸入的文字>
```

**questions**

| 題名 | 型別 | 選項 / 說明 |
| --- | --- | --- |
| `route` | Choice | `main_task`：推進專案、下指令、修改程式碼、對 Claude 剛做的事下決定 · `sidebar_knowledge`：問原理、概念、背景知識，不要求 Claude 改任何東西 · `project_question`：對專案本身的疑問，例如「為什麼我們這裡用 X」，需要 Claude 回答但答案值得留在主線 |
| `is_followup` | Noul | 新 prompt 是不是在延續 `active_thread` 的話題 |
| `needs_project_ctx` | Noul | 回答這題是否需要看到專案的程式碼或對話內容（否 → 可以走 OpenAI） |
| `tag` | Choice | 動態選項 = `tree.tags` + `__new__`。清單為空時跳過此題 |

**決策表**

| route | 信心 | 動作 |
| --- | --- | --- |
| `main_task` | ≥ 0.6 | `next(e)` |
| `sidebar_knowledge` | ≥ 0.6 | `{ drop }` + 旁答 |
| `project_question` | ≥ 0.6 | `next({...e, context: ['[sticky-notes] project question; answer briefly']})`，並在 pane 記一個 `promotedAt = now` 的節點作書籤 |
| 任一 | < 0.6 | `$.ui.ask('這句要進主線還是旁支？', ['主線', '旁支', '追問旁支'])`，答案寫回節點 `route.source = 'ask'` |

`is_followup ≥ 0.6` 且 route 為 sidebar → 掛在 `activeThread` 下；否則開新 root。`tag` 選到 `__new__` 或信心 < 0.5 → 呼叫 OpenAI 取名（見下節），取到的名字 push 進 `tree.tags`。

`is_followup ≥ 0.6` 且 route 為 sidebar → 掛在本 session 的 `activeThread` 下；否則開新 root。`needs_project_ctx ≥ 0.3` 就走 `$.model.fork`（偏保守：寧可多用看得到脈絡的 Claude，少把東西送出去）。`tag` 選到 `__new__` 或信心 < 0.5 → 統整層取名，取到的名字 push 進 `tree.tags`。

**沒有 Jev key 時**：不分類、不問，所有輸入都走主線；只有 `/sticky-note new` 和 pane 追問框能建 note。不用 `$.model.classify` 當退路——它沒有信心值，分錯也看不出來，等於把「不要吞掉我的話」交給一個看不見的判斷。

**標籤命名與主線摘要**都由「OpenAI 統整層」一節定義的工作負責；Jev 這邊只負責在既有標籤中選一個，或選 `__new__`。給 Jev 的 `[recent main-line context]` 在 M4 之後改用 `tree.mainDigest`，M1–M3 先用原文 300 字片段。

**Jev 已知弱點要避開**：不做計數、不比日期；state 不要塞超過幾千字，雜訊會降準確度；對 prompt injection 敏感，所以 state 裡的 assistant 回覆只取前 300 字。中文準確度官方承認較低，若 M1 校正發現 `route` 分不準，先試把 `[new prompt]` 用 OpenAI 翻成英文再送 Jev，成本幾乎為零。

## 使用者操作

**UI 設計對齊**：由於 chat 無相關工具，請在開發過程中與開發者對齊 UI 設計概念。本節的 ASCII 圖只定義 pane 裡放什麼、上下順序是什麼，不代表外觀；真正的樣子由 Claude Code 的元件和 Desktop 主題決定。M2 開始前先做一個只有徽章和空 pane 的骨架，截圖給開發者看過再填內容。

開發者主要在 Claude Desktop 的 Code tab 工作（深色主題、約 1920 寬），2026-10-06 的畫面觀察，供排版參考：

- 左側是 session 側邊欄（約 280 px），按專案分組；主區域是置中的 transcript，寬約 700 px，兩側留白很多。
- session 標題列在上方（專案名 + 分支 chip），右上角有終端機、diff、browser、更多四個 pane 圖示——mod 的 pane 開出來預期會和這些 pane 同一層級，M0 探針確認。
- 工具呼叫在 transcript 裡預設摺疊成一行灰字（「Ran 4 commands, used a tool ›」），`$.ui.log` 的灰色小字應該會長得很像，所以徽章和 toast 要和它們有區別。
- prompt 框上方已經有一張「repo / 分支 / +26,036 −63 / Create PR」卡片和「1 running task」字樣，`AbovePrompt` 帶子會落在這附近；徽章要夠短，不要和這張卡片搶行。
- prompt 框下方一列是 `+`、麥克風、權限模式（Auto）、模型（Sonnet 5.5）、effort（High）、用量圈。OpenAI 用量條放 pane 底部即可，不要再往這一列塞東西。

**預設收合，一個小徽章就好。** Mods 沒有「可自由拖曳的浮動按鈕」這種渲染點，最接近的是 `AbovePrompt`：prompt 框上方一條只有一行高的帶子。平常只畫一個徽章，pane 不開；點徽章（或熱鍵）才 `$.ui.open` 開出完整的樹，pane 右上角本來就有關閉記號。新答案進來不自動開 pane，只讓徽章計數加一並 toast 一下（`autoOpenPane` 預設 `false`）。

```
┌ Sticky Notes 3 · 主線：auth 改 session cookie，剩 token 輪替 ·  [開啟 s] ┐  ← AbovePrompt 帶子，一行
│ > 你的 prompt…                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

點開後的 pane（`$.ui.open({ id: 'sticky', title: 'Sticky Notes' })`）：

```
┌ Sticky Notes ────────────────────────────── [選取] [只看本 session] ┐
│ 主線：正在把 auth 改成 session cookie，剩 token 輪替  [更新摘要 ~8k] │  ← tree.mainDigest，手動更新
│────────────────────────────────────────────────────────────────────│
│ ▾ 大綱：Node stream 效能                       [重算 ~4k ⚠] [digest] │  ← Outline，staleSince 有值時顯示 ⚠
│   ● TCP backpressure 是什麼                 [db]  規劃 session       │  ← root，● = activeThread
│     └ 和 Node stream 的關係                                          │
│        └ highWaterMark 怎麼選                                        │
│   ○ pipeline vs pipe 的差別                 [node]                   │
│ ▸ 大綱：Monorepo 工具（1）                                            │
│ 未整理                                                               │
│   ○ Drizzle 為什麼不用 ORM 關聯              [orm]                   │
│────────────────────────────────────────────────────────────────────│
│ highWaterMark 怎麼選                                                 │  ← 選中的節點
│ 2026-10-06 21:50 · claude-fork · 主線 T14 · 做事 session             │
│ <Markdown 答案，捲動>                                                │
│ [追問…______________________] [送出]  [回流主線] [重新分類] [回到主線] │
│────────────────────────────────────────────────────────────────────│
│ openai 今日 412k / 2,000k · mode=redacted                            │
└────────────────────────────────────────────────────────────────────┘
```

- **點節點 = 導航。** 展開右側答案、設為本 session 的 `activeThread`，帶子上顯示「正在追問：highWaterMark 怎麼選」（`$.ui.status` 當備案；不用 `$.prompt.suggest`，它是「建議的下一句」，按 Tab 會進輸入框被誤送）。接著在主 prompt 框打字，Jev 判成追問就攔進這條鏈，答案出在 pane。「回到主線」清掉 `activeThread` 和帶子上的字。
- **pane 裡的追問框**是第二條路，直接走旁答流程，不經 Jev。
- **選取模式**：按「選取」後每個 root 列變成可勾選（大綱和追問鏈不可選），底部出現「整合 N 個 · 約 xk tokens」；按了才打統整層，產生一個大綱分組。第一版只允許選 root；不做 shift + 方向鍵（`Button` 收不到修飾鍵）。
- **大綱列**：可折疊；「重算」在成員有新追問後亮 ⚠；「digest」寫一頁筆記到 `.claude/sticky-notes/digests/`。
- **回流主線**：送 `title + summary` 進目前這個 session，`$.prompt.submit({ asUser: true })`。節點記 `promotedIn`，樹上標 ↑。要帶進另一個 session，到那邊開 pane 點同一個節點回流即可。
- **重新分類**：把這個節點的問題改送主線（分錯時用）。
- **只看本 session**：用 `anchor.sessionId` 篩選；其他 session 預設看整棵樹。
- **主線上的徽章**：`UserMessage` 渲染點在旁問發生前的那一則主線 user 訊息右側畫「📌 n」（被攔下的旁問本身不會變成訊息，所以只能掛在前一則），點了開 pane 並選中該節點；同一個 handler 裡可用 `$.ui.scroll({ to: messageId })` 反向捲回主線。
- **熱鍵**：`Button.hotkey` 只吃一個數字或小寫字母，帶子的「開啟」用 `s`；沒有 ⌥S。
- 標籤以 `[tag]` 顯示；「整理標籤」手動合併。

**`/sticky-note` 指令**

| 指令 | 動作 |
| --- | --- |
| `/sticky-note` | 開 / 關 pane |
| `/sticky-note new <問題>` | 手動開一張新 note，不經 Jev 路由 |
| `/sticky-note back` | 回到主線（清掉 `activeThread`） |
| `/sticky-note promote [session 名]` | 回流 `activeThread` 進目前這個 session |
| `/sticky-note outline` | 進入選取模式 |
| `/sticky-note refresh` | 手動更新主線進度摘要（會顯示預估 token） |
| `/sticky-note digest [大綱或標籤]` | 把一個大綱或一個標籤壓成一頁筆記寫進 `.claude/sticky-notes/digests/` |
| `/sticky-note export` | 把整棵樹寫成 `.claude/sticky-notes/tree-YYYY-MM-DD.md` |
| `/sticky-note mode <off\|redacted\|full>` | 切換 `openaiContextMode`，只影響本 session |
| `/sticky-note stats` | toast 顯示節點數、大綱數、今日 Jev / OpenAI 呼叫次數、OpenAI token 用量 |
| `/sticky-note feedback good|bad [main|sidebar|followup|project]` | 標記本 session 上一句的路由對不對（路由回饋，見下） |
| `/sticky-note calibrate` | 用標記過的樣本算各門檻的準確率與詢問率（`$.ui.log`，不進模型） |
| `/sticky-note doctor` | 顯示兩把 key 找到與否、從哪個來源（不顯示值） |

**路由回饋**（M1 先做接口，之後再調）：每次 Jev 判斷都記一筆樣本到 `$.store` 的 `route:<root>:<id>`（prompt 前 200 字、Jev 原始機率、當時門檻、決策、建出的節點；每專案最多 500 筆，只存本機）。標記來源：`/sticky-note feedback`、`$.ui.ask` 的選擇（自動當正解）、M2 pane 的「重新分類」。`/sticky-note calibrate` 依標記算出每個門檻會自動路由幾句、對幾句、要問幾句，M1 驗收的 50 句校正就用它。

**透明度**：每次 `{ drop }` 都 `$.ui.log('→ sidebar: ' + title)`，讓我知道那句話去哪了，不會以為沒送出。pane 沒開時改用 `$.ui.toast`。

## 實作分期

每期獨立可用，做完一期先用一兩天再往下。M0 的目的是把文件沒寫清楚的 API 行為摸清楚，不要跳過。

| 期 | 交付 | 驗收 |
| --- | --- | --- |
| **M0 探針** | 空 mod 載入成功；`prompt.submit` 能 `{ drop }`；`$.model.fork` 能被呼叫並確認：答案是否進 transcript、是否接受 `system` / 額外歷史、回傳形狀；`$.model.classify` 的簽名；`$.http.fetch` 打 Jev 與 OpenAI 各成功一次；`$.store` 寫讀一次並確認跨 session 共用；`$.session.messages()` 回傳的欄位夠不夠做摘要；`UserMessage` 渲染點能不能加徽章；`$.prompt.suggest` 在 Desktop 的樣子；`$.session` 能不能列出同專案其他 live session | 一份 `PROBE.md` 記錄每個問題的實測答案，附程式碼片段 |
| **M1 路由** | Jev 四題接上；決策表實作；低信心走 `$.ui.ask`（主線 / 新 note / 追問）；`/sticky-note new` 當手動入口；旁答一律先用 `$.model.fork`，答案 `$.ui.log` 顯示；節點寫入 `$.store`；標題與摘要先用 `$.model.complete` 取 | 用 50 句自己的真實 prompt 跑分類，記錄 route 準確率，據此調門檻；主線 transcript 不出現旁問 |
| **M2 導航** | 徽章 + pane：樹、點節點設 `activeThread` + `$.prompt.suggest` 灰字、答案區、追問框、回到主線、重新分類；主線 `UserMessage` 徽章；`$.ui.log` 透明訊息 | 點節點後在主 prompt 框追問三層正確掛接；回到專案再問會開新 root；主線徽章能開到正確節點 |
| **M3 大綱與多 session** | 選取模式 + 整合大綱（先用 `$.model.complete`）；大綱折疊、重算、⚠；回流到其他 session；只看本 session；`index.md` 同步；`prompt.context` 注入標題索引；封存與 `export`；標籤 `__new__` 命名 | fork 一個 session，兩邊看到同一棵樹；整合 3 個 root 成一個大綱、大綱不可再選；回流到另一個 session 時對方收到摘要；注入 context 用 `$.session.usage()` 量測 < 300 token |
| **M4 供應者切換** | 抽出 `summarize(job, input)` 介面；`providers/claude.ts`（`$.model.complete` + `claudeModel` / `claudeEffort`）與 `providers/openai.ts`（`$.http.fetch` + `redact.ts` + 每日 cap + 用量計數）；`summaryProvider` 設定；知識旁路（`needs_project_ctx = false`）走所選供應者；pane 用量條兩種模式各顯示各的；`/sticky-note mode` `stats` | 切 `summaryProvider` 不改任何其他檔案就能跑完整流程；openai 模式下 `redacted` 攔截真實 payload，確認無 code block、路徑、金鑰；跑滿一天看 Usage 頁面只出現 Data sharing incentive tier、無計費；cap 到了按鈕變灰、不自動改用 Claude；claude 模式下 `claudeModel = sonnet` 能生效 |

**刻意延後的功能**：標籤自動合併整理、圖形化心智圖（SVG 只有 Desktop 能畫）、跨專案搜尋、把旁支內容寫進 CLAUDE.md 的自動化。等 M4 穩定且實際用兩週後再評估。

**測試**：每期用 `claude plugin test` 寫至少一個 `.test.ts`，stub 掉 `$.http.fetch` 與 `$.model.fork`，驗證路由決策表與樹的掛接邏輯。Jev 與 OpenAI 的真實呼叫只在 M0 探針和手動驗收時打。

## 專案結構與設定

```
cc-sticky-notes/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json              # { "modules": ["./register.ts"] }
│   ├── register.ts             # 入口：只做 on(...) 註冊，邏輯放下面
│   ├── route.ts                # Jev 呼叫 + 決策表
│   ├── answer.ts               # $.model.fork / OpenAI 知識旁路
│   ├── digest.ts               # 統整層：主線摘要、旁支摘要、標籤合併、digest 排程
│   ├── redact.ts               # openaiContextMode=redacted 的剝除規則
│   ├── tree.ts                 # $.store 讀寫、節點掛接、封存
│   ├── pane.tsx                # ui.render + ui.press/input/select
│   ├── commands.ts             # /sticky-note 系列
│   ├── jev.ts                  # TypeSafe API client（只這一檔知道 schema）
│   ├── openai.ts               # OpenAI client + 每日用量計數 + 預算退回
│   └── index.ts                # index.md / export / digests 寫檔
├── types/
│   └── index.d.ts              # PluginState 宣告（pane 的 UI 狀態）
├── tests/
│   ├── route.test.ts
│   ├── tree.test.ts
│   ├── redact.test.ts
│   ├── jev.test.ts / notes.test.ts / feedback.test.ts / ui.test.ts
├── PROBE.md                    # M0 探針結果
└── README.md
```

**plugin.json**

```json
{
  "name": "cc-sticky-notes",
  "version": "0.1.0",
  "description": "cc-sticky-notes: route curiosity questions to a side pane instead of the main conversation",
  "types": "types/index.d.ts",
  "userConfig": {
    "routeThreshold": { "type": "number", "default": 0.6, "description": "Minimum Jev confidence before asking the user" },
    "followupThreshold": { "type": "number", "default": 0.6 },
    "summaryProvider": { "type": "string", "default": "claude", "description": "claude | openai — which model does titles, summaries, outlines and the knowledge side path" },
    "claudeModel": { "type": "string", "default": "haiku", "description": "Model for $.model.complete when summaryProvider is claude" },
    "claudeEffort": { "type": "string", "default": "low", "description": "Effort for $.model.complete when summaryProvider is claude" },
    "openaiModel": { "type": "string", "default": "gpt-5-mini" },
    "openaiReasoningEffort": { "type": "string", "default": "minimal", "options": ["minimal", "low", "medium", "high", "none"], "description": "gpt-5 系列是推理模型，不設 minimal 時短工作的 token 會被推理吃光、回覆是空的（M0 實測）；none = 不送這個參數" },
    "openaiContextMode": { "type": "string", "default": "redacted", "description": "off | redacted | full — what project content may be sent to OpenAI" },
    "openaiDailyTokenCap": { "type": "number", "default": 2000000, "description": "Pause OpenAI calls past this many tokens per UTC day" },
    "autoOpenPane": { "type": "boolean", "default": false, "description": "Open the pane automatically when a sidebar answer arrives" },
    "contextIndexMaxTokens": { "type": "number", "default": 300 }
  }
}
```

`userConfig` 的確切 schema 格式以 plugins 的 manifest reference 為準，上面是意圖。

**金鑰**：`TYPESAFE_API_KEY` 與 `OPENAI_API_KEY` 不要求設成 Windows 整機 / 使用者環境變數。依序取第一個找到的：(1) 行程環境變數（終端機、CI 用；`$.env.get`，名稱必須是字串常值）；(2) `~/.claude/sticky-notes/.env`，使用者層級、不跟任何 repo 走，正式使用放這裡；(3) mod 自己資料夾下的 `.env`，開發時用，已在 `.gitignore`。**不讀目前專案的 `.env`**：很多專案自己的 `.env` 就有那個 app 的 `OPENAI_API_KEY`，讀到會誤用。金鑰值不寫進 log、`$.store` 或任何設定檔；`/sticky-note doctor` 只顯示每把 key 找到與否、從哪裡來。OpenAI key 用一個專用 Project 建立，只對該 Project 開資料分享。缺 key 時 mod 仍要能載入：缺 Jev → 全部進主線，只留手動入口；缺 OpenAI 而 `summaryProvider = openai` → 退回 `claude`，toast 一次。

**開發時載入**：`claude --plugin-dir ./cc-sticky`-notes，存檔自動 reload。載入後 Claude Code 會寫出 `.claude-plugin/types/claude-code/index.d.ts`，這份是該版本的權威型別，PROBE 階段先讀它。

## 多 session 工作流

我的習慣是一個專案一個 session 起頭，脈絡成形後用 Desktop 的 fork（等同 `/branch`）分出第二、第三個 session——一個做事、一個規劃——context 太長時還會直接再開一個新的。所以同一專案同時有三四個 live session 是常態。這件事 mod 不介入：不猜哪句話是在規劃、不幫忙 fork、不幫新 session 命名。它只保證不管開幾個 session，看到的都是同一棵樹，而且新 session 一開就知道之前問過什麼。

| 需求 | 做法 |
| --- | --- |
| N 個 session 看到同一棵樹 | `$.store` 的 key 以專案 key（`repo()?.root ?? root()`）開頭，不帶 session；fork 的、重開的、不同 worktree 的都自然共用 |
| 兩個 session 同時寫不互蓋 | 節點、大綱、各 session 的 activeThread 各自一個 key（M0 實測：同 key 併發會掉寫入，不同 key 不會） |
| 分辨哪張 note 是哪邊問的 | `anchor.sessionId`；pane 可篩「只看本 session」 |
| 各 session 的「目前追問中」互不干擾 | `active:<root>:<sessionId>`，各自一份 |
| 為了 context 長度重開新 session 時不從零開始 | `prompt.context` 注入標題索引（< 300 token）；若 `mainDigest` 存在，pane 頂端立刻顯示上一個 session 留下的主線摘要，使用者可以選擇把它回流進新 session 當開場 |
| 規劃 session 的結論帶進做事 session | 不做跨 session 傳送（列不出同專案的 session、拿不到 Desktop 的 session 名稱，做出來也難選）。改為：到做事 session 開 pane、點同一個節點、回流——樹是共用的，這就夠了 |
| 哪個 session 都能整理 | 整合大綱、重算、refresh 不限 session；`mainDigest.sessionId` 記最後是誰更新的 |

## 風險、未知與要先驗證的事

**文件沒寫清楚、M0 必須實測的**

| 問題 | 若答案不如預期的備案 |
| --- | --- |
| `$.model.fork({ prompt })` 的答案會不會寫進 transcript 或 session 檔？ | 若會，改用 `$.model.complete`，自己把 `$.session.messages()` 最近 N 則 + 旁支歷史組成 prompt；代價是沒有 prompt cache |
| `fork` 能否帶 `system` 或額外 messages（放旁支歷史）？ | 不能的話，把旁支歷史直接串在 `prompt` 文字前面 |
| `fork` 在 `prompt.submit` hook 裡呼叫，而該 hook 回 `{ drop }`——這算不算「turn 進行中」？會不會卡住或等待？ | 改成 hook 先回 `{ drop }`，旁答在 `$.clock.after(0, …)` 的背景工作裡做 |
| `$.model.classify` 的簽名與回傳 | 若好用，可以取代 Jev 的 `route` 題（省一個外部依賴）；Jev 保留給 `tag` 動態選項 |
| `prompt.submit` 的 `e` 有沒有 `turnId` 或可對應主線位置的欄位？ | 沒有就在 `turn.start` 自己記最後一個 turnId |
| hook 10 秒限制：Jev 呼叫 + 可能的 `$.ui.ask` 等待 | `$.ui.ask` 是 mods API 呼叫不計時；Jev 用 `$.http.fetch` 也是。只有自己寫的邏輯計時，應該安全，但要量 |
| `$.store` 是否真的跨 session、跨 `--plugin-dir` 與正式安裝共用 | 不共用就在 M3 改存 `~/.claude/sticky-notes/<hash>.json` |
| 在 Desktop，`AbovePrompt` 帶子長什麼樣、佔多高？mod 開的 `Pane` 能不能像內建 pane 一樣拖曳排版、關閉、彈出成獨立視窗？`Button` 的 `hotkey` 在 Desktop 吃不吃 ⌥ 組合鍵？ | 帶子不能用就退回 `$.ui.status`（prompt 下方一行）+ `/sticky-note` 開關；pane 不能拖就接受 dock 位置，靠「預設收合」把干擾降到最低 |
| UserMessage 渲染點能否在既有訊息右側加一顆小按鈕（徽章）而不蓋掉原文？$.prompt.suggest 的灰字在 Desktop 怎麼顯示、會不會被送出？$.session 能否列出同專案其他 live session 的 id 與名稱？pane 裡能否收到 shift + 方向鍵這類組合鍵（決定選取模式要不要做多選手勢）？$.ui.scroll 能否捲主 transcript？ | 徽章不行就只在 pane 顯示 anchor；suggest 不行就用 $.ui.status 顯示「正在追問：…」；列不出 session 就讓使用者貼 session id；沒有組合鍵就用「選取」按鈕切模式；不能捲主 transcript 就在節點下顯示主線那一句的前 120 字 |

M0 的實測結果在 repo 的 `PROBE.md`，上表保留為提問紀錄；兩者衝突以 `PROBE.md` 為準。已確認的重點：`prompt.submit` 的 `{ drop }` 會在畫面留一行提示、session 檔的佇列紀錄留原文，但模型 context 乾淨；`$.store` 跨 session 共用但同 key 併發會掉寫入；`$.model.classify` 不回信心值；`$.session` 沒有 list；邏輯模組拿不到 `$`，要用 `register.ts` 同檔的 closure（Ports）傳進去。

**外部依賴風險**

- Mods 10/1 才推出，文件自己說事件與方法會隨版本變。鎖定 Claude Code 版本號在 README，每次升級跑一次 `claude plugin validate` 和測試。
- Jev 9/22 起暫停新註冊，價格、速率限制仍在調整；`jev-1.13.0` 今天的版本。`jev.ts` 隔離 schema，壞了只改一檔。
- OpenAI 免費額度隨時可能結束（承諾提前 30 天通知）；跨過當日上限的那一筆整筆計費；帳戶要維持正餘額。`openai.ts` 的用量計數要保守，預設 cap 設在額度的 80%。

**執行環境**：主要使用場景是 Claude Desktop 的 Code tab（本機 session）。Mods 的 pane、按鈕、`Markdown`、`Input`、`Select` 在 Desktop 都能畫，`Svg` 只有 Desktop 能畫（之後可做真正的心智圖），`Raster` / `Image` 只有終端機能畫，所以不要用。Desktop 的 WSL session 不載入 plugin；cloud session 只跑 hook、不畫任何自訂 UI。M2 的 pane 版面以 Desktop 為準，終端機能看就好。

**隱私**

- 開了資料分享的 OpenAI Project，所有輸入輸出都可能被拿去訓練。這是我知情同意的交換，但要可控：`openaiContextMode` 預設 `redacted`，`redact.ts` 剝除 code block、路徑、疑似金鑰；`off` 時任何含專案內容的工作改走 `$.model.complete`。M4 驗收要實際攔截 payload 檢查。
- `redacted` 不是保證：變數名、架構討論、業務邏輯描述仍會出門。在客戶專案或含敏感資料的 repo 工作時，用 `/sticky-note mode off`，或在該 repo 的 `.claude/settings.json` 把 `pluginConfigs` 的 `openaiContextMode` 設成 `off`。
- Jev 收到的 state 含 `mainDigest`（已經是 OpenAI 產的摘要）或 M1–M3 的 300 字原文片段。TypeSafe 的資料政策要先讀過；若不接受，改成只送 `[new prompt]` 與 `[sidebar state]`，犧牲一些 `is_followup` 準確度。

**行為風險**

- 分類錯誤把任務指令吞進旁支：有「重新分類」按鈕和 `/sticky-note new` 補救，`$.ui.log` 讓錯誤可見。M1 驗收的準確率低於 85% 就把門檻拉高、多問。
- `{ drop }` 之後我可能忘了那句話存在：pane 自動開啟 + toast 是必要的，不是可選。
- Mod 以我的權限執行，`$.process` 不會用到，`$.fs.write` 只寫 `.claude/sticky-notes/` 底下。

## 給 Claude Code 的開工指令

把這份文件匯出成 Markdown 放在 repo 根目錄 `PLAN.md`，然後在 Claude Code 貼下面這段：

```
讀 PLAN.md。這是一個 Claude Code mod 專案（cc-sticky-notes），目標、架構、資料模型、分期都在裡面。

先做 M0 探針，不要先寫正式功能：
1. 執行 `claude --version` 確認 ≥ 2.1.287。
2. 建一個最小 mod（plugin.json + hooks.json + register.ts），用 `claude --plugin-dir ./cc-sticky-notes` 載入。
3. 讀 Claude Code 生成的 `.claude-plugin/types/claude-code/index.d.ts`，把 PLAN.md「風險、未知與要先驗證的事」表格裡每一題在型別檔中找答案；型別檔答不了的，寫最小程式碼實測。
4. 把每題的結論與證據寫進 PROBE.md。遇到和 PLAN.md 假設不符的地方，在 PROBE.md 標「⚠ 偏離計畫」並提議修正，先問我再改架構。
5. 用 $.http.fetch 各打一次 Jev 與 OpenAI，確認回傳格式；順便確認 $.session.messages() 回傳的欄位足以做主線摘要。金鑰從環境變數 TYPESAFE_API_KEY、OPENAI_API_KEY 讀，不要寫進檔案。

M0 驗收後再開 M1。每期結束跑 `claude plugin validate` 與 `claude plugin test`。
```

UI 部分：由於 chat 無相關工具，請在開發過程中與開發者對齊 UI 設計概念。每個介面里程碑先出骨架截圖、確認後再填，不要憑 ASCII 圖直接做完。

**參考文件（開工時先讀）**

- Mods 總覽：https://code.claude.com/docs/en/plugins/mods/overview
- 事件：https://code.claude.com/docs/en/plugins/mods/events
- mods API：https://code.claude.com/docs/en/plugins/mods/api
- 介面與 pane：https://code.claude.com/docs/en/plugins/mods/interface
- 參考表（所有事件、API、限制）：https://code.claude.com/docs/en/plugins/mods/reference
- 測試：https://code.claude.com/docs/en/plugins/mods/test
- 權威型別：https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts（可能比本機版本舊，以本機生成的為準）
- TypeSafe Console 與 Playground：https://console.typesafe.ai
- OpenAI 資料分享與免費額度說明：https://help.openai.com/en/articles/10306912-sharing-feedback-evals-and-api-data-with-openai

**給 Claude Code 的工作原則**

- 每個外部服務一個檔案，schema 不外洩到其他模組。
- 任何會 `{ drop }` 使用者輸入的路徑，都必須有對應的 `$.ui.log` 或 toast。
- 寫測試時 stub `$.http.fetch`、`$.model.fork`、`$.model.complete`，不打真實 API。
- 不確定的 API 行為先查本機型別檔，再寫探針，不要憑印象。
- PLAN.md 是意圖，PROBE.md 是事實；兩者衝突時以 PROBE.md 為準並回報。
