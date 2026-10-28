import { describe, expect, mock, test } from 'claude-code/testing'

import type { GitInfo } from '../types'

const NOW = Date.parse('2026-10-22T04:00:00Z')

const PANE = {
  plugin: 'desk-panel',
  component: 'Pane',
  requestId: 'desk-panel',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// 使用者在 prompt 打的指令：引擎會蓋上來源與版面
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const REPO = { root: '/repo', remote: null, internal: false, name: 'repo', id: 'r1' } as const
const GIT_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as const
const EDIT_RESULT = {
  filePath: '/repo/hooks/register.tsx',
  oldString: 'old',
  newString: 'new',
  originalFile: 'keep\nold\n',
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+added'] }],
  userModified: false,
} as const

describe('register', () => {
  test('the pane shows the plan, usage and background tasks, on every surface', async ($, on) => {
    // 測試裡沒有引擎：每個 hook 都代替引擎回答
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({
      value: {
        startedAt: NOW,
        context: { tokens: 88_000, window: 200_000, percent: 44 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 4, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
          { kind: 'seven_day', percentUsed: 23 },
        ],
        cost: { usd: 1.5 },
      },
    }))
    on('agent.list', () => ({ value: [] }))
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b123' },
    }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read the usage API', status: 'completed', activeForm: 'Reading the usage API' },
        { content: 'Wrap each section', status: 'in_progress', activeForm: 'Wrapping each section' },
        { content: 'Write the tests', status: 'pending', activeForm: 'Writing the tests' },
      ],
    })
    await $.tool.call({ tool: 'Bash', command: 'sleep 600', description: 'Watch the build log', run_in_background: true })
    // 用量與子代理只在面板開著時取
    await $.command.run({ command: 'panel', args: '', ...RUN })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ key: 'section:plan' }))?.text).toMatch(/Plan\s+1\/3/)
      expect(await ui.find({ type: 'Text', text: /Wrapping each section/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Write the tests/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Current session$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Current week \(all models\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ 23% used$/ })).toBeDefined()
      // session 只寫時刻（整點不寫分鐘，半小時時區會有分鐘），時區依執行環境
      expect(await ui.find({ type: 'Text', text: /^Resets \d{1,2}(:\d{2})?(am|pm)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Total cost: \$1\.50/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Watch the build log/ })).toBeDefined()
      expect((await ui.find({ key: 'section:tasks' }))?.text).toMatch(/1 running/)
      await ui.unmount()
    }
  })

  test('changes list the edited file, a press shows its last diff, and activity counts tools', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: NOW - 30 * 60_000, context: { window: 200_000 }, rateLimits: [] } }))
    on('session.model', () => ({ value: 'Opus 5.5' }))
    on('session.root', () => ({ value: '/repo' }))
    on('session.turns', () => ({ value: 3 }))
    on('agent.list', () => ({ value: [] }))
    on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '/repo/README.md', content: '' } } }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: EDIT_RESULT }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/hooks/register.tsx', old_string: 'old', new_string: 'new' })
    await $.command.run({ command: 'panel', args: '', ...RUN })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect(await ui.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /30m\s+·\s+3 turns/ })).toBeDefined()
      expect((await ui.find({ key: 'section:changes' }))?.text).toMatch(/Changes\s+1 file/)
      expect((await ui.find({ key: '/repo/hooks/register.tsx' }))?.text).toMatch(/M hooks\/register\.tsx/)
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.press({ key: '/repo/hooks/register.tsx' })
      expect(await ui.find({ type: 'Code' })).toBeDefined()
      await ui.press({ key: '/repo/hooks/register.tsx' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      // Activity 預設收合，按標題展開；展開狀態跨畫面沿用，所以最後再收回去
      expect(await ui.find({ type: 'Text', text: /This turn/ })).toBeUndefined()
      await ui.press({ key: 'section:activity' })
      expect(await ui.find({ type: 'Text', text: /This turn: 2 tools/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Read 1 · Edit 1|Edit 1 · Read 1/ })).toBeDefined()
      await ui.press({ key: 'section:activity' })
      await ui.unmount()
    }
  })

  test('git, context and agents fill their sections; sections fold and /panel reset restores them', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', (_, e) => ({
      value: {
        startedAt: NOW - 60 * 60_000,
        context: {
          tokens: 50_000,
          window: 200_000,
          percent: 25,
          ...(e.breakdown === undefined
            ? {}
            : {
                breakdown: {
                  categories: [
                    { name: 'System prompt', tokens: 3_000, color: 'claude', isDeferred: false, kind: 'used' },
                    { name: 'Messages', tokens: 47_000, color: 'suggestion', isDeferred: false, kind: 'used' },
                    { name: 'Free space', tokens: 150_000, color: 'inactive', isDeferred: false, kind: 'free' },
                  ],
                  totalTokens: 50_000,
                  maxTokens: 200_000,
                  rawMaxTokens: 200_000,
                  autocompactSource: 'model-default',
                  percentage: 25,
                  gridRows: [],
                  model: 'Opus 5.5',
                  memoryFiles: [],
                  mcpTools: [],
                  agents: [],
                  isAutoCompactEnabled: true,
                  apiUsage: null,
                },
              }),
        },
        rateLimits: [],
      },
    }))
    on('session.model', () => ({ value: 'Opus 5.5' }))
    on('session.root', () => ({ value: '/repo' }))
    on('session.turns', () => ({ value: 1 }))
    on('session.repo', () => ({ value: REPO }))
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Explore the repo', type: 'Explore', status: 'running' }] }))
    on('ui.view', () => ({ value: {} }))
    // 代替 git：依參數回答
    on('process.run', (_, e) => {
      const args = e.argv.join(' ')
      const stdout = args.includes('rev-list')
        ? ''
        : args.includes('rev-parse')
          ? 'master\n'
          : args.includes('--numstat')
            ? '3\t1\tREADME.md\n'
            : args.includes('status')
              ? ' M README.md\n?? notes.txt\n'
              : args.includes('log -1')
                ? `abc1234\x1fInitial commit\x1f${Math.floor((NOW - 3_600_000) / 1000)}\n`
                : args.includes('diff HEAD -- README.md')
                  ? 'diff --git a/README.md b/README.md\n@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more\n'
                  : ''

      return { value: { ...GIT_OK, exitCode: args.includes('rev-list') ? 128 : 0, stdout } }
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // git：branch、未 commit 檔案數、最後一個 commit；Changes 列出 Claude 沒動到的檔案，按下取 git diff。
    // 非 Windows 路徑的 key 保留大小寫
    expect((await ui.find({ key: 'section:git' }))?.text).toMatch(/Git\s+master/)
    expect(await ui.find({ type: 'Text', text: /2 uncommitted files/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Initial commit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Other uncommitted changes/ })).toBeDefined()
    expect((await ui.find({ key: 'git:/repo/README.md' }))?.text).toMatch(/M README\.md \+3 −1/)
    expect((await ui.find({ key: 'git:/repo/notes.txt' }))?.text).toMatch(/\? notes\.txt/)
    await ui.press({ key: 'git:/repo/README.md' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    // subagent 那列是按鈕，按下切去看它的對話
    expect((await ui.find({ key: 'agent:a1' }))?.text).toMatch(/agent Explore the repo/)
    await ui.press({ key: 'agent:a1' })

    // Context 預設收合，按下展開
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeUndefined()
    await ui.press({ key: 'section:context' })
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeDefined()
    expect((await ui.find({ key: 'section:context' }))?.text).toMatch(/25% used/)

    // 收起 Plan；/panel reset 讓它再展開、Context 收回
    await ui.press({ key: 'section:plan' })
    expect(await ui.find({ type: 'Text', text: /no plan or todos yet/ })).toBeUndefined()
    await $.command.run({ command: 'panel', args: 'reset', ...RUN })
    expect(await ui.find({ type: 'Text', text: /no plan or todos yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeUndefined()
    await ui.unmount()
  })

  test('opening the panel flags this session so the status line hides; closing it clears the flag', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const writes: { path: string; text: string }[] = []
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's1' }))
    on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\Tester' : undefined }))
    // 使用者建立了旗標資料夾
    on('fs.exists', () => ({ value: true }))
    on('fs.write', (_, e) => {
      // 引擎在 Windows 上會把路徑轉成反斜線，比對前統一成正斜線
      writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })

      return { value: undefined }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    expect(writes.at(-1)).toEqual({ path: 'C:/Users/Tester/.claude/desk-panel/open/s1', text: 'open' })
    await $.command.run({ command: 'panel', args: 'close', ...RUN })
    expect(writes.at(-1)).toEqual({ path: 'C:/Users/Tester/.claude/desk-panel/open/s1', text: 'closed' })
  })

  test('without the flag folder nothing is written; /panel checks for it again', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const writes: string[] = []
    let hasFolder = false
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's1' }))
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
    // 引擎會把路徑改成宿主的寫法（Windows 上是反斜線、可能補磁碟代號），所以只比對結尾
    on('fs.exists', (_, e) => ({ value: hasFolder && /[\\/]\.claude[\\/]desk-panel[\\/]open$/.test(e.path) }))
    on('fs.write', (_, e) => {
      writes.push(e.path.replace(/\\/g, '/'))

      return { value: undefined }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    await $.command.run({ command: 'panel', args: 'close', ...RUN })
    expect(writes).toHaveLength(0)

    // 之後建立了資料夾：下一次 /panel 重查，開始寫旗標
    hasFolder = true
    await $.command.run({ command: 'panel', args: '', ...RUN })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/\/home\/tester\/\.claude\/desk-panel\/open\/s1$/)
  })

  test('a task notification marks the background task finished', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.list', () => ({ value: [] }))
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b123' },
    }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'sleep 600', description: 'Watch the build log', run_in_background: true })
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification>\n<task-id>b123</task-id>\n<status>completed</status>\n</task-notification>',
          },
        ],
      },
      door: 'delivery',
      origin: { kind: 'task-notification' },
      uuid: 'n1',
    })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /running/ })).toBeUndefined()
    await ui.unmount()
  })

  test('billed through the API: no plan limits, so Usage says so and labels the cost pay-as-you-go', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('agent.list', () => ({ value: [] }))
    // API key／雲端供應商計費：回應不帶 5 小時／每週額度，rateLimits 一律是空的
    let hasResponded = false
    on('session.usage', () => ({
      value: hasResponded
        ? { startedAt: NOW, context: { tokens: 24_000, window: 200_000, percent: 12 }, rateLimits: [], cost: { usd: 0.42 } }
        : { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
    }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await before.find({ type: 'Text', text: /^Plan limits: shown after the first response$/ })).toBeDefined()
    // 還沒有花費（0）就不顯示那一行
    expect(await before.find({ type: 'Text', text: /^Total cost/ })).toBeUndefined()
    await before.unmount()

    // 第一個回應之後，下一輪更新（每 5 秒）拿到 token 數與花費
    hasResponded = true
    await clock.advance(5000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ key: 'section:usage' }))?.text).toMatch(/Usage\s+API billing/)
      expect(await ui.find({ type: 'Text', text: /^ 12% used$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^24k \/ 200k tokens$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Plan limits: none \(billed per token via API\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Current session$/ })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /^Total cost/ }))?.text).toBe('Total cost: $0.42 (pay-as-you-go)')
      await ui.unmount()
    }
  })

  test('a data source that fails marks its own section, and the rest keeps drawing', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => {
      throw new Error('usage endpoint down')
    })
    on('session.model', () => {
      throw new Error('model lookup failed')
    })
    on('session.root', () => ({ value: '/repo' }))
    on('session.turns', () => ({ value: 2 }))
    on('agent.list', () => {
      throw new Error('agent roster offline')
    })
    on('session.repo', () => ({ value: REPO }))
    // git 讀不了這個 repo（例如 safe.directory 擋下的 dubious ownership）
    on('process.run', () => ({
      value: { ...GIT_OK, exitCode: 128, stderr: "fatal: detected dubious ownership in repository at '/repo'\n" },
    }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    // 每 5 秒輪詢的來源連續失敗兩次才標出來
    await clock.advance(5000)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      // 標頭：模型取不到就寫 unknown，其他欄位照常；沒取到開始時刻就不顯示經過時間
      expect(await ui.find({ type: 'Text', text: /^\(model unknown\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^2 turns$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^⚠ session info: / })).toBeDefined()
      expect((await ui.find({ key: 'section:usage' }))?.text).toMatch(/Usage\s+⚠/)
      expect(await ui.find({ type: 'Text', text: /^⚠ usage unavailable: / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^⚠ subagent list unavailable: / })).toBeDefined()
      expect((await ui.find({ key: 'section:git' }))?.text).toMatch(/Git\s+⚠/)
      expect(await ui.find({ type: 'Text', text: /^⚠ git unavailable: fatal: detected dubious ownership/ })).toBeDefined()
      // 沒出錯的區塊照畫
      expect(await ui.find({ type: 'Text', text: /no plan or todos yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /no background tasks/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a value an earlier version stored in another shape only takes down its own section', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.list', () => ({ value: [] }))
    // 舊版本留下的值：changes 混了壞掉的項目、activity 的欄位型別不對、plan 少了 items、git 沒有 fileCount
    on('state.get', ($, e, next) => {
      if (e.key === 'changes') return { value: { value: [null], version: 1 } }
      if (e.key === 'activity') return { value: { value: { running: 'x', counts: [], errors: 'n' }, version: 1 } }
      if (e.key === 'plan') return { value: { value: { planText: 3 }, version: 1 } }
      if (e.key === 'git') {
        return {
          value: { value: { root: '/repo', branch: 'main', files: [{ key: '/repo/a.txt', path: 'a.txt', status: 'M' }], sessionCommits: [] }, version: 1 },
        }
      }

      return next(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ key: 'section:changes' }))?.text).toMatch(/Changes\s+⚠/)
    expect(await ui.find({ type: 'Text', text: /^⚠ could not draw this section: / })).toBeDefined()
    // 整理得回來的值當作空的；沒有總數就數清單
    expect(await ui.find({ type: 'Text', text: /no plan or todos yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Plan limits: shown after the first response$/ })).toBeDefined()
    expect((await ui.find({ key: 'section:git' }))?.text).toMatch(/Git\s+main/)
    expect(await ui.find({ type: 'Text', text: /1 uncommitted file$/ })).toBeDefined()
    await ui.press({ key: 'section:activity' })
    expect(await ui.find({ type: 'Text', text: /This turn: 0 tools/ })).toBeDefined()
    await ui.unmount()
  })

  test('a press whose action fails says why in a toast', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const toasts: string[] = []
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.root', () => ({ value: '/repo' }))
    on('tool.call', { tool: 'Edit' }, () => ({
      result: {
        filePath: '/repo/notes.md',
        oldString: 'old',
        newString: 'new',
        originalFile: 'old\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
        userModified: false,
      },
    }))
    on('command.run', { command: 'diff' }, () => {
      throw new Error('diff viewer unavailable')
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/notes.md', old_string: 'old', new_string: 'new' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'open-diff' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^Could not open \/diff: /)
    expect((await ui.find({ key: 'section:changes' }))?.text).toMatch(/Changes\s+1 file/)
    await ui.unmount()
  })

  test('a closed panel neither spawns git nor polls; opening it refreshes at once and keeps what was tracked', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    let gitRuns = 0
    let usageReads = 0
    let agentReads = 0
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.repo', () => ({ value: REPO }))
    on('process.run', (_, e) => {
      gitRuns += 1

      return { value: { ...GIT_OK, stdout: e.argv.includes('rev-parse') ? 'master\n' : '' } }
    })
    on('session.usage', () => {
      usageReads += 1

      return { value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }
    })
    on('agent.list', () => {
      agentReads += 1

      return { value: [] }
    })
    on('tool.call', { tool: 'Edit' }, () => ({ result: EDIT_RESULT }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/hooks/register.tsx', old_string: 'old', new_string: 'new' })
    // 面板關著：三輪輪詢與編輯後的 git 防抖都過了，什麼都沒跑
    await clock.advance(15_000)
    expect(gitRuns).toBe(0)
    expect(usageReads).toBe(0)
    expect(agentReads).toBe(0)

    // 開啟：立刻取齊；關著時記下的編輯還在
    await $.command.run({ command: 'panel', args: '', ...RUN })
    expect(gitRuns).toBeGreaterThan(0)
    expect(usageReads).toBeGreaterThan(0)
    expect(agentReads).toBeGreaterThan(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'section:changes' }))?.text).toMatch(/Changes\s+1 file/)
    expect((await ui.find({ key: 'section:git' }))?.text).toMatch(/Git\s+master/)
    await ui.unmount()

    // 關掉後輪詢停止
    await $.command.run({ command: 'panel', args: 'close', ...RUN })
    const afterClose = usageReads
    await clock.advance(10_000)
    expect(usageReads).toBe(afterClose)
  })

  test('an auto-open the terminal was too narrow for refreshes on its first draw', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // 上次用 /panel 開著：新工作階段自動開啟
    mock.store(on, { autoOpen: true })
    let gitRuns = 0
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.repo', () => ({ value: REPO }))
    on('process.run', (_, e) => {
      gitRuns += 1

      return { value: { ...GIT_OK, stdout: e.argv.includes('rev-parse') ? 'master\n' : '' } }
    })
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.list', () => ({ value: [] }))
    // 終端太窄：面板開了但沒畫出來
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is 100 columns wide; a pane opened unasked waits for 144' } }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.advance(5000)
    expect(gitRuns).toBe(0)

    // 終端變寬，畫面第一次畫出面板：排程的更新跑完後 Git 區塊有資料
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.settle()
    expect(gitRuns).toBeGreaterThan(0)
    expect((await ui.find({ key: 'section:git' }))?.text).toMatch(/Git\s+master/)
    await ui.unmount()
  })

  test('git stores at most 100 uncommitted files but shows the true count', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const status = Array.from({ length: 120 }, (_, index) => ` M file-${index}.txt`).join('\n')
    let stored: GitInfo | null | undefined
    on('command.register', () => ({ value: { command: 'panel' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('agent.list', () => ({ value: [] }))
    on('session.repo', () => ({ value: REPO }))
    on('process.run', (_, e) => {
      const args = e.argv.join(' ')
      const stdout = args.includes('status') ? `${status}\n` : args.includes('rev-parse') ? 'master\n' : ''

      return { value: { ...GIT_OK, exitCode: args.includes('rev-list') ? 128 : 0, stdout } }
    })
    on('state.set', (_, e, next) => {
      if (e.key === 'git') stored = e.value as GitInfo | null

      return next(e)
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'panel', args: '', ...RUN })
    expect(stored?.files).toHaveLength(100)
    expect(stored?.fileCount).toBe(120)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /120 uncommitted files/ })).toBeDefined()
    await ui.unmount()
  })
})
