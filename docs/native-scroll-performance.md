# 原生滚动骨架与缩略图局部刷新：实现和验证

本轮基线为 `b1decdf053a164d46769461daa2389e4a4dcbd74`，包版本仍为 0.2.4。环境：Pi SDK/TUI **1.5.2**、Node **24.22.3**、Apple M1 Pro / 32 GiB。这里记录的是扩展内重构，没有修改 Pi 安装、依赖版本、全局配置或系统代理，也没有发布或安装到日常 Pi。

## 1. 解决的问题与保留的行为

长会话的卡顿并不只发生在拖动时：一次输入或普通重绘，也会经过正文渲染、布局测量、历史核对和图片合成。旧 `HStack` 接入增加了正文测量，扩展在原生遍历之外又扫描卡片和不可变行；底图完成还会请求一次完整 TUI 帧。

本轮保留原始 `ScrollView` 槽位与完整 document 契约，优化重复工作和刷新调度：

- 不再用额外 `HStack` 替换 transcript 槽位。正文宽度预留标记和约正文宽度 6% 的缩略图区域；最右一列仍由 Pi 原生滚动条绘制、命中和捕获。
- 在宿主布局完成、overlay 合成之前绘制侧栏，并添加只用于侧栏命中的局部 layout box。正文仍是 ScrollView 的第一子节点，不为侧栏再次排版正文。
- 保留原生滑块拖动、轨道点击、滚轮、键盘导航和 End 跟随。侧栏滚轮进入宿主 `routeWheel`，避免继承的 Container 鼠标路径以错误宽度再渲染一次全文。
- 保留压缩前只读历史、重复/技能/图片输入、准确锚点、展开、分支、主题和 resize，以及草稿、焦点、搜索、选择和完整退出消费者输出。
- 弹窗打开时原生滑块沿用宿主的禁用命中规则，需先关闭弹窗；缩略图也暂停绘制。这不是用常驻 overlay 冒充侧栏。

适配范围仍仅确认 Pi 1.5.2。使用的是可恢复的实例钩子，不修改全局原型；不支持的布局或历史错误会恢复原视图，清理不覆盖后来安装的外来钩子。

## 2. 重复工作的削减

### 正文与原生卡片

`src/viewport.ts` 在一个真实 `doRender` 帧内限定 `History.beginFrame/endFrame`，同宽度的重复 document 读取可共享已发布结果。跨宽度切换只有当前宽度和行引用都对应时才复用；帧外的显式全文读取不使用这一缓存。

`src/history.ts` 只对确认是原生 renderer、没有 Markdown transformer 的 User/Assistant 卡片保存两个宽度的 UI 渲染结果。原生 `invalidate`、内容更新、rebuild 和子节点变更显式清缓存。未知 renderer、后安装的外来 wrapper 和 transformer 走正常渲染/检查路径；不把任意第三方组件当成不可变对象。

普通帧沿宿主已有的 chat 遍历核对原始卡片顺序，不再额外 `filter/some` 整个原生列表。同一数组中的组件替换会在发布前重绑定；连续变动失败时恢复原生视图，而不是发布错位锚点。已知原生 message ID 优先用于绑定，并核对签名和匹配游标；未持久化、无 ID 的实时卡片保留兼容匹配路径。

不可变原生 span/run 元数据只在源引用、宽度、高度或正文头偏移变化时重建。普通输入复用整段，跳过逐行相等比较。移除卡片、失败、reload/off 会释放缓存、绑定闭包和旧 snapshot 引用。

### 缩略图独立完成

`src/sidebar.ts` 收到新底图就绪时优先调用 `GraphicMinimap.redraw(false)`，只更新已显示的图像区域，不请求正文帧。首次还没有有效图像/布局时才回退普通帧；overlay 期间不画图、不请求这个额外帧。

`src/png.ts` 用 Node 异步 zlib 压缩新 worker raster 所需的协议 PNG。准备和压缩均结束后才原子发布像素、版本与 PNG，并计入 pending。epoch、worker 和 job 身份校验防止取消后的旧图复活。字形准备、scanline 拷贝和小图合成仍有主线程工作，不能称为全部工作已移到 worker。

背板仍是局部真实文字，最多三屏 / 4096 像素高。预留文档末端后的空白像素，新增流式行可以继续裁取旧背板，而不是立即清图并要求全文重绘；只读取存在的正文行，没有抽样、伪造正文或改变文字比例。拖动框反馈继续只用缓存像素，不等待正文、字形或 worker。

## 3. 前后测量口径

所有性能对照使用独立 Node 进程，串行执行，不让 before/after 同时争用 CPU。

- 基线由 `git archive` 保存到 `.test-artifacts/native-gutter/before-src/`，使用相同的本地 fixture、性能脚本和同机依赖。两个脚本都显式挂载真实 Sidebar，避免旧 fixture 的占位 gutter 影响对照。
- 每条输入配一条回复。`native` 保留全部原生卡片；`archived` 原生只保留最后十对，压缩前全文仍完整展示。不能拿归档尾部场景代替未压缩场景。
- 真实 Pi 组件 + MemoryTerminal，默认 100×24，resize 到 160 列。一个样本计动作与一次 `renderNow()`；追加包含创建、持久化模拟回复的动作。
- 主要 1 万输入对照两轮，idle/scroll 各 300 样本，append/refresh 各 50 样本。第一轮 before→after，第二轮反转场景顺序并 after→before。下面的范围是**两轮各自中位数的最小/最大值**，不是置信区间。
- 首次准备和 resize 等待使用 Pi 自然调度，每 5ms 只检查就绪状态；稳态帧间 `setImmediate`。首次 UI 时间从 `f.start()` 开始，不含此前造数据、JSONL 读取、完整 CLI 启动和模型请求。
- 规模对照各一轮，idle/scroll 各 200 样本，append/refresh 各 50 样本。1 万输入进程 heap 上限 2048 MiB，规模对照 3072 MiB；没有强制 GC。
- 输出只计字节。以下不是物理终端输入到显示、图片解码、GPU 或真实模型速度，也不是跨机器最坏延迟保证。

原始证据在 `.test-artifacts/extension-refactor/native-gutter-final-paired-{before,after}-r{1,2}-*.json`、`native-gutter-final-scale-*.json`；选定指标汇总在 `.test-artifacts/native-gutter/final-benchmark-summary.json`。测试和证据仅本机保留，被 Git 忽略，不纳入提交或分发包。

## 4. 性能结果

### 1 万输入、8 万行、未压缩

单位 ms，表内为两轮中位数范围：

| 能力 | idle：改前 → 改后 | 滚动：改前 → 改后 | 追加回复：改前 → 改后 |
| --- | ---: | ---: | ---: |
| 仅标记 | 44.41–44.54 → 10.87–13.41 | 43.97–44.85 → 10.78–12.73 | 64.11–66.19 → 43.60–45.61 |
| Kitty | 42.17–49.07 → 11.21–12.09 | 42.92–48.12 → 10.92–12.52 | 78.42–78.93 → 41.97–50.34 |
| iTerm2 | 42.42–44.65 → 11.33–11.34 | 43.18–44.02 → 10.80–11.43 | 64.63–67.98 → 43.59–44.03 |

普通帧中位耗时降低约 **70%–75%**，滚动约快 **3.3–4.1 倍**；不是所有操作都有这个收益。追加仍约 42–50ms。

长尾没有全部消失：改后滚动 p95 约 **12.44–18.41ms**、p99 **14.56–22.57ms**，这两轮中最大滚动样本 **67.85ms**。不能标记“所有普通帧都在 16ms 内”或“无 >50ms 长任务”。

未压缩冷同步约 **656–814ms**；resize 同步约 **446–524ms**。即使稳态已经快了，首次原生卡片排版和冷宽度切换仍会卡顿。

### 不拖动：真实按键与实时文本

1 万输入，40 次真实键盘输入，随后 20 次助手内容增长加打字；无鼠标事件。动作计一次显式帧，计数也包括自然调度和最后 settle 帧。

| 能力 / 未压缩 | 固定历史打字中位：改前 → 改后 | 实时更新加打字中位：改前 → 改后 |
| --- | ---: | ---: |
| 仅标记 | 45.90 → 11.15ms | 47.01 → 19.85ms |
| Kitty | 49.74 → 12.91ms | 51.77 → 21.36ms |
| iTerm2 | 43.37 → 14.14ms | 44.13 → 27.07ms |

三种能力中，固定历史打字的 document 调用均 **84 → 42**；Kitty/iTerm2 实时更新阶段 **60 → 22**。新底图 ready 不再制造额外正文帧；专门用例还覆盖同高文本替换和新增尾行。

固定历史打字前后都是 **0 raster jobs、0 image uploads**。本轮解决的不只是栅格任务，而是普通输入帧中的重复正文工作。

1 万输入归档打字改后中位约 **3.09–3.68ms**，没有同等倍数收益；图像开启的实时更新中位约 **5.67–6.07ms**，本次略高于基线约 **4.17–5.66ms**。更新时图像上传也增加：未压缩 Kitty **2 → 8**，iTerm2 **1 → 26**。旧背板在末端之外无空间时会被清除，多个更新等到最后才显示；新行为保留图像、随视口移动并局部发布完成结果。**减少正文帧不等于减少每种协议的传输字节**，不宣称流式图像吞吐全面改善。

证据：`.test-artifacts/native-gutter-final-paired-{before,after}-no-drag-10000-{markers,kitty,iterm2}-{native,archived}.json`。

### 归档和规模边界

1 万输入归档仍约 **2.37–2.86ms idle、2.52–2.93ms 滚动、2.89–3.08ms 追加**。基线已约 3ms，本轮主要收益在未压缩历史和更大行数组，不能套用“四倍”说法。

以下为单轮中位数，单位 ms：

| 输入 / 行数 / 能力 | idle：改前 → 改后 | 滚动：改前 → 改后 | 追加：改前 → 改后 |
| --- | ---: | ---: | ---: |
| 1,000 / 8,000 / 未压缩仅标记 | 2.51 → 2.12 | 2.47 → 2.13 | 3.70 → 4.11 |
| 1,000 / 8,006 / 归档仅标记 | 1.00 → 1.54 | 0.92 → 1.64 | 0.98 → 1.72 |
| 1,000 / 8,006 / 归档 Kitty | 0.97 → 1.69 | 1.17 → 1.97 | 1.26 → 1.78 |
| 1,000 / 8,006 / 归档 iTerm2 | 0.94 → 1.60 | 1.08 → 1.75 | 0.99 → 1.76 |
| 125,000 / 1,000,006 / 归档仅标记 | 26.84 → 12.46 | 25.50 → 12.26 | 25.93 → 14.73 |
| 125,000 / 1,000,006 / 归档 Kitty | 23.08 → 11.99 | 22.43 → 11.99 | 23.66 → 14.73 |
| 125,000 / 1,000,006 / 归档 iTerm2 | 21.72 → 12.03 | 22.39 → 11.94 | 24.22 → 14.23 |

小归档本次有约 **0.5–0.8ms** 的固定开销增加，不能宣称所有规模更快；这些是串行单轮测量，不推断它的跨机器稳定幅度。

百万行的全部精确就绪改后约 **7.95–8.20s**，resize 全部就绪 **6.84–7.23s**，并非即时打开。改后滚动 p95 **20.86–21.65ms**；无图像轮次还出现 **381ms** 滚动样本。最终 RSS 快照约 **2.44–2.84GiB**，包含会话、全部组件/行数组、两个宽度缓存、背板和采样数据，不是纯 UI 成本、峰值或 GC 后的存活内存。这里只验证百万行完整且有所提速，不是百万行硬实时验收。

## 5. 行为验证

- `npm run check` 通过；七个改动源码的主动 LSP 检查均 0 diagnostics；**186 项本地测试全部通过**。
- 新用例覆盖原始槽位/原生 fine 条、侧栏 native wheel、同帧复用/宽度交替、普通输入访问数、同数组组件替换、原生失效/transformer/外来 wrapper 回退、已知 message ID、致命失败清理；也覆盖局部 ready 零正文帧、流式尾行不清图、overlay 不覆盖、异步 PNG 就绪/取消/失败和同步/异步 codec 一致性。
- 保留完整搜索、跨屏选择载荷、全部锚点顺序、分支和草稿/focus 检查。退出消费者取得完整 document 的用例不等于物理终端退出恢复验收。
- 实际 Pi CLI 在**隔离 HOME/agent 配置、网络被阻止、仿 TTY 管道**中，1,000 输入的 none / Kitty / iTerm2 均 PASS：归档点击、真实比例和 cell-size reply、局部文字点击、reload/off、分支与焦点保持。
- 两种图像协议各 **20 秒持续拖动、16 次 invalidate**，同一手势及原生 capture 保持，最终位置准确。无其他功能性扩展，仅生命周期探针。
- 七个相关宿主文件的 SHA256 与实现前一致，包括布局、ScrollView、两种 TUI 和原生交互/User/Assistant 组件。

证据：`.test-artifacts/native-gutter/final-{check,tests}.log`、`host-final.json`；`.test-artifacts/cli-report-{none,kitty,iterm2}-native-gutter-final-verified.json` 及对应 ANSI / longdrag 文件。

### 连续输入而非逐步 settle

真实 MemoryTerminal 中 64 个 16ms 脉冲，每脉冲 4 次 SGR move，活跃输入期间不调用 `renderNow/settle`：

| 历史 | 协议 | 256 次 move 合并为正文滚动 | 框输出中位 / 最大 | 脉冲延后最大 |
| --- | --- | ---: | ---: | ---: |
| 1 万条归档普通文本 | iTerm2 | 23 次 | 0.272 / 0.620ms | 4.636ms |
| 1 万条归档普通文本 | Kitty | 23 次 | 0.008 / 0.101ms | 4.743ms |
| 3,000 条代码/CJK/组合字符/emoji | iTerm2 | 20 次 | 0.914 / 1.494ms | 23.202ms |
| 3,000 条代码/CJK/组合字符/emoji | Kitty | 21 次 | 0.007 / 0.097ms | 16.809ms |

正文在松手前跟随，最终位置、焦点和草稿均正确。富文本脉冲也有超过 16ms 的延后，不能把同步框输出时间当作全部输入响应。

证据：`.test-artifacts/native-gutter-final-{drag,rich-drag}.json`。

## 6. 仍未消除的成本

这不是虚拟化：宿主 Container 的全文拼接/新数组、全历史行发布、冷排版、原生巨消息解析、完整搜索和 SessionManager 加载仍存在。两个宽度缓存是数量限制，不是全历史总字节限额；局部 minimap 背板有界，不代表整个会话内存有界。第三方 renderer 和 transformer 回退会失去部分加速。

真实终端视觉、输入到显示、图像解码/GPU、物理输出拥塞和任意第三方 UI 扩展组合未验收。后台仿 TTY 不包含这些成本，没有启动/激活桌面终端、抢夺焦点或修改代理。

实现仅在本仓库。正在加载本地目录的 Pi 可用 `/reload` 应用；安装的发布版不会自动更新。本轮未发布、安装或变更版本号。

## 7. 本地复跑

已有本机测试文件时可运行；这些脚本不随包分发：

```sh
npm run check
npm test
PI_SCROLLBAR_BENCH_NATURAL=1 node --max-old-space-size=2048 \
  --experimental-transform-types tests/extension-refactor-performance.ts 10000 native local 300 kitty
PI_SCROLLBAR_BENCH_LABEL=local-no-drag node --max-old-space-size=2048 \
  --experimental-transform-types tests/no-drag-performance.ts 10000 iterm2
PI_SCROLLBAR_BENCH_RICH=1 PI_SCROLLBAR_BENCH_LABEL=local-rich-drag \
  node --experimental-transform-types tests/drag-continuous.ts
PI_SCROLLBAR_TEST_LABEL=local PI_SCROLLBAR_TEST_INPUTS=1000 \
  PI_SCROLLBAR_TEST_PROTOCOL=kitty PI_SCROLLBAR_TEST_LONG_DRAG=1 python3 tests/cli.py
```

性能脚本将 `native` 改为 `archived` 测归档；最后一个协议参数可用 `none/kitty/iterm2`。测基线时只替换脚本路径为上述 `before-src/tests/...`，使用不同 label 保留独立证据。
