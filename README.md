# pi-visible-scrollbar

为 Pi 全屏会话添加右侧导航条，点击用户输入标记即可回到对应位置，也可开启 VS Code 风格的文字缩略图，快速浏览长会话。

## 效果预览

![Pi 全屏会话右侧的文字缩略图、视口框、输入标记与滚动条](docs/assets/visible-scrollbar.jpg)

图为早期版本开启缩略图后的效果示意。默认只显示输入标记和滚动滑块；使用 `/scrollbar minimap on` 开启试验性缩略图。当前版本的缩略图会随长会话滚动，不会把全部文字挤进一屏。

## 功能

- **输入定位**：点击标记跳到对应用户输入；多条输入重叠时可展开列表选择。
- **拖动滚动**：拖动右侧滑块浏览会话，点击轨道跳到相应位置。
- **文字缩略图**：显示微缩文字和当前视口框，可拖动视口框或点击文字导航，默认关闭。
- **完整分支历史**：可定位当前分支中压缩前的输入、重复输入、技能调用和纯图片输入。压缩前历史以只读方式显示，不重新加入模型上下文。
- **键盘导航**：通过命令选择输入、跳到上一条或下一条，随时返回底部并继续跟随输出。
- **不打扰当前工作**：跳转只改变阅读位置，不重发输入、不切换分支、不改动输入框草稿；没有模型调用、网络请求、遥测或额外 token 开销。

## 安装

面向 **Pi 1.5.2 的全屏模式**，其他版本兼容性尚未确认。`regular` 模式不支持。

### 从 GitHub 安装

```sh
pi install git:github.com/llc2214926/pi-visible-scrollbar
```

安装后重新启动 Pi，或在当前会话执行 `/reload`。使用全屏模式启动：

```sh
pi --tui-mode fullscreen
```

### 本地试用

在本仓库目录安装依赖后启动，不写入安装设置：

```sh
npm install --ignore-scripts
pi --no-extensions --extension ./index.ts --tui-mode fullscreen
```

需要长期使用时，可安装本地目录：

```sh
pi install /absolute/path/to/pi-visible-scrollbar
```

避免同时启用其他替换会话布局或滚动条的扩展。

## 用法

### 鼠标操作

| 位置 | 操作 |
| --- | --- |
| `━` 输入标记 | 单击跳到这条输入 |
| `≡` 密集标记 | 悬停或点击展开列表，再点击具体输入跳转 |
| 密集输入列表 | 滚轮翻页，点击标题或按 `Esc` 关闭 |
| 最右侧 `┃` 滑块 | 拖动滚动；点击轨道按比例跳转 |
| 缩略图视口框 | 拖动浏览会话 |
| 缩略图文字 | 单击跳到对应位置；框外拖动不会滚动会话 |

查看历史后，按 Pi 的 `Ctrl+End` 或执行 `/scrollbar end` 返回底部并恢复跟随输出。

### 命令

| 命令 | 功能 |
| --- | --- |
| `/scrollbar on` / `/scrollbar off` | 启用或关闭；关闭后恢复原布局和滚动条 |
| `/scrollbar status` | 查看启用状态、输入数量及缩略图不可用的原因 |
| `/scrollbar list` | 从当前分支的全部用户输入中选择并跳转 |
| `/scrollbar prev` / `/scrollbar next` | 跳到上一条或下一条用户输入 |
| `/scrollbar end` | 返回底部并恢复跟随输出 |
| `/scrollbar minimap on` / `/scrollbar minimap off` | 开启或关闭试验性文字缩略图 |

### 缩略图使用条件

- 需要直接使用支持 **iTerm2 或 Kitty 图像协议**的终端，并允许 Pi 显示终端图像。`terminal.images: false` 或 `PI_IMAGE_PROTOCOL=none` 会禁用缩略图；tmux、screen、Zellij 中也不启用。
- 默认导航条占 3 列。开启缩略图后，会在旁边增加约为正文宽度 6% 的预览区域，不覆盖正文。
- 终端宽度不足 60 列时暂停缩略图，放宽后自动恢复；不支持图像时仍可使用输入标记和滚动滑块。
- 打开弹窗、搜索或密集输入列表时，缩略图会暂时隐藏，关闭后恢复。
- 文字显示取决于系统字体，emoji 以方框占位；图片附件不会显示为原图缩略图。

### 配置

开关命令会保存设置，通常无需手动编辑。配置文件为 `<agent-dir>/visible-scrollbar.json`，默认路径是 `~/.pi/agent/visible-scrollbar.json`。

未创建配置文件时使用以下默认值：

```json
{
  "enabled": true,
  "experimentalMinimap": false
}
```

手动修改后执行 `/reload`。配置格式有误时扩展会提示原因并停止启用。

---

采用 [MIT 许可](LICENSE)。参考项目与许可归属见 [NOTICE.md](NOTICE.md)。
