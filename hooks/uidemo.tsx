// /sticky-note ui-demo: a temporary map of every place the mod can draw on the
// desktop and terminal, each labeled with a letter, so the developer can pick
// where the UI goes (PLAN.md「UI 設計對齊」). Pure views; register.ts hooks them.
import type { ElementTable, RenderElement } from 'claude-code'

export const DEMO_SITES = [
  ['A', 'AbovePrompt', '輸入框上方的帶子（現在的位置）：一整列，可放按鈕'],
  ['B', 'SessionMode', '輸入框下方、最右邊的模式標籤（和 Auto / 模型那排同一列）：幾個字'],
  ['C', 'PromptHint', '輸入框下方的灰色提示行：一行字（會蓋掉原本的提示）'],
  ['D', '$.ui.status', '輸入框下方的狀態列：一行字，不能點'],
  ['E', 'Spinner', '回答進行中那一列（只在 Claude 工作時出現）'],
  ['F', 'UserMessage', '對話裡每一則你的訊息旁：小徽章，可放按鈕'],
  ['G', 'AssistantMessage', '對話裡每一則回覆的最下面：一行或一個小區塊'],
  ['H', 'CommandOutput', '/sticky-note 指令的輸出列：可以在對話裡畫一整張卡片'],
  ['I', 'Pane', '右側的 pane（位置由 Desktop 決定）'],
  ['J', '$.ui.toast', '右上角的 toast：幾秒後消失'],
  ['K', '$.ui.log', '對話裡的灰色小字，模型讀不到'],
] as const

export const DEMO_LEGEND = DEMO_SITES.map(([k, site, where]) => `〔${k}〕${site}：${where}`)

export const label = (k: string) => `〔${k}〕`

/** F: a badge beside the user's message. */
export function userBadge(els: ElementTable, original: RenderElement): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" gap={1}>
      {original}
      <Text dimColor>{label('F')}📌</Text>
    </Box>
  )
}

/** G: a line under the assistant's reply. */
export function replyFooter(els: ElementTable, original: RenderElement): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      {original}
      <Text dimColor>{label('G')} 📌 這裡可以放「相關便利貼」</Text>
    </Box>
  )
}

/** H: a whole card in the transcript, drawn in the command's output row. */
export function commandCard(els: ElementTable): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{label('H')} 指令輸出列也能畫一整張卡片</Text>
      {DEMO_LEGEND.map(line => (
        <Text key={line}>{line}</Text>
      ))}
      <Text dimColor>再打一次 /sticky-note ui-demo 關掉。</Text>
    </Box>
  )
}
