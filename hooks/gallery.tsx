// TEMP: /sn ui-gallery — every element and style the pane can use, drawn once, so the
// developer can see on Desktop what renders and how before the pane is redesigned.
// Remove after the redesign (REQUESTS.md / PROBE.md「側邊欄美化」).
import type { ElementTable, RenderElement } from 'claude-code'

export const GALLERY_ID = 'sticky-gallery'
export const GALLERY_TITLE = 'UI Gallery'

const THEME_KEYS = [
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged',
  'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide',
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
] as const

const BORDER_STYLES = ['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic'] as const

const GLYPHS = '● ○ ◆ ◇ ■ □ ▸ ▾ ◀ ▶ ↑ ↓ → ← ✓ ✗ ★ ☆ … · ─ │ └ ├ ┌ ┐ ⏳ ⚠ ①②③'

const MARKDOWN = [
  '# 標題一',
  '## 標題二',
  '### 標題三',
  '',
  '一般文字，**粗體**、*斜體*、`inline code`、~~刪除線~~、[連結](https://example.com)。',
  '',
  '- 清單一',
  '- 清單二',
  '  - 巢狀',
  '1. 編號一',
  '2. 編號二',
  '- [ ] 待辦',
  '- [x] 完成',
  '',
  '> 引言：便利貼的答案可以這樣強調。',
  '',
  '| 欄位 | 說明 |',
  '| --- | --- |',
  '| title | 12 字內 |',
  '| summary | 三句 |',
  '',
  '```ts',
  'const tree = await loadTree(kv, root)',
  '```',
  '',
  '---',
  '分隔線上下',
].join('\n')

const CODE = `export function derive(tree: Tree): Tree {
  const roots = Object.values(tree.nodes).filter(n => n.parentId === null)
  return { ...tree, roots: roots.map(n => n.id) }
}`

const DIFF = `--- a/hooks/notes.ts
+++ b/hooks/notes.ts
@@ -1,2 +1,2 @@
-const QUESTION_CHARS = 30
+const QUESTION_CHARS = 24
 const PREVIEW_CHARS = 40`

const SVG_TREE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120">
  <style>text{font:12px sans-serif;fill:#555}rect{fill:#EEEDFE;stroke:#534AB7;rx:6}.c rect{fill:#E1F5EE;stroke:#0F6E56}</style>
  <g><rect x="10" y="45" width="90" height="30"/><text x="55" y="64" text-anchor="middle">樹載入原因</text></g>
  <path d="M100 60 L150 25 M100 60 L150 95" stroke="#888" fill="none"/>
  <g class="c"><rect x="150" y="10" width="110" height="30"/><text x="205" y="29" text-anchor="middle">為何全讀節點</text></g>
  <g class="c"><rect x="150" y="80" width="110" height="30"/><text x="205" y="99" text-anchor="middle">children 何時算</text></g>
</svg>`

const SVG_HOVER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 60" width="320" height="60">
  <style>rect{fill:#F1EFE8;stroke:#888;transition:fill .2s}rect:hover{fill:#FAC775}text{font:12px sans-serif;fill:#444;pointer-events:none}</style>
  <rect x="10" y="10" width="140" height="40" rx="6"><title>hover 提示：這是 title tooltip</title></rect>
  <text x="80" y="35" text-anchor="middle">滑鼠移上來會變色</text>
  <rect x="170" y="10" width="140" height="40" rx="6"><title>第二個 tooltip</title></rect>
  <text x="240" y="35" text-anchor="middle">也有 tooltip</text>
</svg>`

export type GalleryActions = { event(what: string): void }

export function galleryView(els: ElementTable, lastEvent: string, act: GalleryActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const Input = 'Input' in els ? els.Input : undefined
  const Select = 'Select' in els ? els.Select : undefined
  const Svg = 'Svg' in els ? els.Svg : undefined
  const Link = 'Link' in els ? els.Link : undefined
  const Code = 'Code' in els ? els.Code : undefined

  const section = (n: number, title: string, body: RenderElement) => (
    <Box key={`s${n}`} flexDirection="column" gap={1}>
      <Text bold>{`${n}. ${title}`}</Text>
      {body}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={2}>
      <Text dimColor>{`TEMP ui-gallery · 最後一個互動：${lastEvent || '（還沒有）'}`}</Text>

      {section(1, 'Text 樣式', (
        <Box flexDirection="column">
          <Text>一般 normal</Text>
          <Text bold>粗體 bold</Text>
          <Text italic>斜體 italic</Text>
          <Text underline>底線 underline</Text>
          <Text strikethrough>刪除線 strikethrough</Text>
          <Text dimColor>變淡 dimColor</Text>
          <Text inverse>反白 inverse</Text>
          <Text bold italic underline color="claude">組合 bold + italic + underline + claude</Text>
          <Text wrap="truncate-end">{'截斷 truncate-end：' + '很長的一行文字，'.repeat(20)}</Text>
          <Text>{'換行 wrap：' + '很長的一行文字，'.repeat(12)}</Text>
        </Box>
      ))}

      {section(2, 'Text 顏色（主題色）', (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {THEME_KEYS.map(k => (
            <Text key={`c-${k}`} color={k}>{k}</Text>
          ))}
          <Text color="#D97757">#D97757</Text>
          <Text color="#1D9E75">#1D9E75</Text>
          <Text color="rgb(83,74,183)">rgb(83,74,183)</Text>
        </Box>
      ))}

      {section(3, 'Text 背景色', (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {(['success', 'error', 'warning', 'claude', 'planMode', 'subtle', 'diffAdded', 'diffRemoved'] as const).map(k => (
            <Text key={`bg-${k}`} backgroundColor={k}>{` ${k} `}</Text>
          ))}
          <Text backgroundColor="#FAEEDA" color="#633806">{' #FAEEDA '}</Text>
        </Box>
      ))}

      {section(4, 'Box 邊框樣式', (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {BORDER_STYLES.map(s => (
            <Box key={`b-${s}`} borderStyle={s} paddingX={1}>
              <Text>{s}</Text>
            </Box>
          ))}
        </Box>
      ))}

      {section(5, 'Box 邊框顏色、背景色', (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Box borderStyle="round" borderColor="claude" paddingX={1}><Text>borderColor claude</Text></Box>
          <Box borderStyle="round" borderColor="success" paddingX={1}><Text>success</Text></Box>
          <Box borderStyle="round" borderColor="#534AB7" paddingX={1}><Text>#534AB7</Text></Box>
          <Box borderStyle="round" borderDimColor paddingX={1}><Text>borderDimColor</Text></Box>
          <Box backgroundColor="subtle" paddingX={1}><Text>backgroundColor subtle</Text></Box>
          <Box backgroundColor="#EEEDFE" paddingX={1}><Text color="#3C3489">#EEEDFE</Text></Box>
        </Box>
      ))}

      {section(6, '版面（flex）', (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" borderStyle="single" paddingX={1}>
            <Text>左：space-between</Text>
            <Text dimColor>右 3 則</Text>
          </Box>
          <Box flexDirection="row" gap={2}>
            <Box borderStyle="round" paddingX={1} flexGrow={1}><Text>flexGrow 1</Text></Box>
            <Box borderStyle="round" paddingX={1} flexGrow={2}><Text>flexGrow 2</Text></Box>
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box borderStyle="round" paddingX={1} paddingY={1}><Text>paddingY 1</Text></Box>
            <Text>alignItems center</Text>
          </Box>
          <Box width={30} borderStyle="single" paddingX={1}><Text>width 30</Text></Box>
          <Box width="50%" borderStyle="single" paddingX={1}><Text>width 50%</Text></Box>
        </Box>
      ))}

      {section(7, 'Hover（滑鼠移上去）', (
        <Box flexDirection="column" gap={1}>
          <Box borderStyle="round" borderDimColor paddingX={1} hover={{ borderColor: 'claude', borderDimColor: false }}>
            <Text>Box hover：邊框變 claude 色</Text>
          </Box>
          <Box paddingX={1} hover={{ backgroundColor: 'subtle' }}>
            <Text>Box hover：背景變 subtle</Text>
          </Box>
          <Text hover={{ color: 'claude', underline: true }}>Text hover：變色加底線</Text>
          <Box flexDirection="row" gap={1} hover={{ scope: 'row-a' }}>
            <Text>同一個 scope 一起亮：</Text>
            <Text hover={{ scope: 'row-a', color: 'success' }}>A</Text>
            <Text hover={{ scope: 'row-a', color: 'success' }}>B</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>hover 才出現 →</Text>
            <Box display="none" hover={{ display: 'flex' }}>
              <Text color="claude">我是 reveal 的內容</Text>
            </Box>
          </Box>
        </Box>
      ))}

      {section(8, 'Button', (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key="g-btn-default" label="default" onPress={() => act.event('Button default')} />
            <Button key="g-btn-primary" variant="primary" label="primary" onPress={() => act.event('Button primary')} />
            <Button key="g-btn-secondary" variant="secondary" label="secondary" onPress={() => act.event('Button secondary')} />
            <Button key="g-btn-dim" dimColor label="dimColor" onPress={() => act.event('Button dimColor')} />
            <Button key="g-btn-dismiss" role="dismiss" label="關閉（role dismiss）" onPress={() => act.event('Button dismiss')} />
          </Box>
          <Button key="g-btn-plain" plain label="plain：○ 樹載入原因" onPress={() => act.event('Button plain')} />
          <Button key="g-btn-hotkey" plain hotkey="g" label="plain + hotkey g" onPress={() => act.event('Button hotkey g')} />
          {/* Button with Text children: the types show it, but 2.1.293 refuses it ("takes one string child, its label, or none") */}
          <Text dimColor>Button 不能放 Text children（型別檔有範例，但引擎 2.1.293 拒絕）</Text>
          <Button key="g-btn-hover" plain hover={{ color: 'claude', bold: true }} label="plain + hover 變色" onPress={() => act.event('Button hover')} />
        </Box>
      ))}

      {section(9, 'Input / Select', (
        <Box flexDirection="column" gap={1}>
          {Input ? (
            <Input key="g-input" label="追問" placeholder="追問這一則…" submitLabel="送出" value="" onSubmit={v => act.event(`Input submit「${v}」`)} />
          ) : (
            <Text dimColor>（這個畫面沒有 Input）</Text>
          )}
          {Select ? (
            <Select
              key="g-select"
              label="排序"
              options={[{ value: 'time', label: '依時間' }, { value: 'tag', label: '依標籤' }, { value: 'session', label: '只看本 session' }]}
              value="time"
              onSelect={v => act.event(`Select ${v}`)}
            />
          ) : (
            <Text dimColor>（這個畫面沒有 Select）</Text>
          )}
        </Box>
      ))}

      {section(10, 'Link', Link ? (
        <Box flexDirection="column">
          <Link href="https://example.com" label="https 連結（example.com）" />
          <Link href="http://localhost:3000" label="http://localhost 連結" />
          <Text dimColor>file: 連結 Desktop 畫成純文字（只接受 https 與 http://localhost）</Text>
        </Box>
      ) : <Text dimColor>（這個畫面沒有 Link）</Text>)}

      {section(11, 'Code', Code ? (
        <Box flexDirection="column" gap={1}>
          <Code source={CODE} language="ts" path="hooks/tree.ts" startLine={120} />
          <Code source={DIFF} format="diff" path="hooks/notes.ts" />
        </Box>
      ) : <Text dimColor>（這個畫面沒有 Code）</Text>)}

      {section(12, 'Markdown', <Markdown text={MARKDOWN} />)}

      {section(13, 'Svg', Svg ? (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>靜態：</Text>
          <Svg source={SVG_TREE} alt="便利貼樹的示意圖" width={320} height={120} />
          <Text dimColor>isInteractive（hover 變色、title tooltip）：</Text>
          <Svg source={SVG_HOVER} alt="hover 示範" width={320} height={60} isInteractive />
        </Box>
      ) : <Text dimColor>（這個畫面沒有 Svg：終端機不支援）</Text>)}

      {section(14, '可用的符號（Unicode）', <Text>{GLYPHS}</Text>)}
    </Box>
  )
}
