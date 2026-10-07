// TEMPORARY Remote Control probe helpers (PROBE.md「Remote Control」). Delete after the probe,
// together with the TEMP section of register.tsx.
//
// Prompts the probe owns (the router skips them):
//   rcprobe-plain <text>     pass through; logs prompt.submit and classic.UserPromptSubmit
//   rcprobe-suppress <text>  classic.UserPromptSubmit answers suppressOriginalPrompt (+ a context marker)
//   rcprobe-block <text>     classic.UserPromptSubmit answers block
//   rcprobe-drop <text>      prompt.submit answers { drop } (the mod's current way)
//   rcprobe-ask              drop, then 3 s later $.ui.ask with a 300-character question
//   rcprobe-askpreview       drop, then 3 s later AskUserQuestion through $.tool.call with option previews

export const RCPROBE_LOG = 'rcprobe:log'
export const RCPROBE_ON = 'rcprobe:on'
export const CONTEXT_MARKER = 'KIWI42'

export const isProbePrompt = (text: string) => text.trimStart().startsWith('rcprobe-')

export const probeCommand = (text: string) => /^rcprobe-([a-z]+)/.exec(text.trimStart())?.[1] ?? null

/** 300 characters with a marker every 50, to see where a surface cuts it. */
export function longQuestion(): string {
  let s = ''
  for (let i = 1; [...s].length < 300; i++) {
    const tag = `〔${i * 50}〕`
    s += tag + '測'.repeat(50 - [...tag].length)
  }
  return [...s].slice(0, 299).join('') + '？'
}

export const PREVIEW_QUESTION = {
  question: 'cc-sticky-note：這是一則便利貼的答案預覽，B 上看得到下面的 preview 嗎？',
  header: 'rcprobe',
  multiSelect: false,
  options: [
    {
      label: '收到答案',
      description: '選項說明：CRDT 是無衝突複製資料型別',
      preview: '# CRDT\n\n**無衝突複製資料型別**：多個副本各自修改，最後自動收斂。\n\n- 計數器\n- 集合\n- 文字協作',
    },
    { label: '只看到選項', description: '沒有看到 preview 區塊' },
  ],
}
