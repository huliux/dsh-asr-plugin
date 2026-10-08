# dsh-asr-plugin

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@huliux/dsh-asr-plugin)](https://www.npmjs.com/package/@huliux/dsh-asr-plugin)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

面向 Apple Silicon macOS 的 DeepSeek Harness（DSH）非官方本地会议转写插件。
支持导入 WAV、M4A、MP3 文件，录制麦克风与系统音频，生成包含时间戳和
说话人标签的转写文本。会议可在 DSH 消息中显式引用，用于阅读与导出。

![录音继续进行时引用当前会议生成阶段性总结](assets/screenshots/recording-live-summary.jpg)

示例使用语音合成的虚构会议。在录音继续进行时，通过 `@` 引用当前会议，
让配置的 DeepSeek 模型读取实时草稿并生成阶段性总结。总结是用户主动请求的
当前快照，后续可能随草稿变化。完整案例与环境信息见
[案例截图](assets/screenshots/README.md)。
[官方社区展示帖](https://github.com/deepseek-ai/deepseek-harness/discussions/9125)。

## 兼容性

| 组件 | 要求 |
| --- | --- |
| 宿主 | DSH 0.2.0-rc.2 |
| 运行时 | Node.js 24 |
| 平台 | macOS、Apple Silicon（`darwin` / `arm64`） |
| 麦克风 API | macOS 13.5 或更高版本 |
| 系统音频与双轨 API | macOS 14.2 或更高版本 |

上述 macOS 版本表示 API 可用下限，不代表完整的操作系统测试矩阵。
DSH 桌面版和 Web 模式均在运行 DSH 的 Mac 上处理音频。
Windows、Linux 和 Intel Mac 不受支持。

## 安装

在 DSH 插件页安装 `@huliux/dsh-asr-plugin`。Web 配置也支持命令行安装：

```sh
dsh plugin --profile web add --ignore-scripts @huliux/dsh-asr-plugin@0.1.2
```

安装包包含原生模块和采用 ad-hoc 签名的录音 Helper。Helper 未经过 Apple
公证；安装和更新后，macOS 可能要求权限或安全确认。请保持系统安全保护开启。

桌面与 Web 配置共用默认会议库。每个数据目录同时运行一个插件宿主；
更换安装包时保留会议与模型数据。

安装包校验、本地归档安装与版本渠道见 [分发说明](docs/distribution.md)。
源码下载后需要完成 [源码构建](docs/development.md) 才能录音。
安装问题请通过 [GitHub Issues](https://github.com/huliux/dsh-asr-plugin/issues)
反馈，并附插件、DSH、Node.js 和 macOS 版本；请勿附会议数据或凭据。

## 模型准备

在插件设置中下载基础模型，约 278 MiB。可选标点模型约 274 MiB，
通过校验并安装后自动用于新录音、导入与重新转写。活动任务和已有转写
保留原处理模式。已安装的标点包损坏时，须修复后才能启动新任务。

模型来自固定的上游版本，安装前校验文件大小和 SHA-256。
权重不包含在 Git、npm 或 GitHub Release 中。启用插件不会触发下载。
下载可取消和重试；失败后可复用已完整下载并通过校验的文件。
来源、代理行为与离线导入方法见 [模型资源](docs/model-assets.md)。

## 录音与会议访问

通过插件设置中的“录音权限”检查麦克风与系统音频访问。
每次开始录音都会重新检查。系统音频检查失败可能与权限、输出音量或
设备路由有关；录音期间的静音不能证明权限被拒绝。

展开录音助手会准备模型，但不采集音频。连续录音可复用已加载的模型资源，
闲置五分钟后释放。每场会议的音频、草稿和说话人状态保持独立。

选择 DSH 会话后录音，或要求 DSH Agent 导入本机音频的绝对路径。
通过 `@` 选择会议并请求阅读或导出；文件写入使用 DSH 审批。
会议独立于 DSH 会话和工作区保存。

紧凑录音条显示正在采集时的控制项：

![正在录音的紧凑组件](assets/screenshots/recording-active.jpg)

展开后可以查看录音计时、音轨状态和实时转写草稿：

![展开录音组件查看实时草稿](assets/screenshots/recording-expanded.jpg)

导入音频或录音结束后，可引用会议的正式转写，提炼决策与行动项：

![引用演示会议后提炼决策与行动项](assets/screenshots/meeting-summary.jpg)

模型准备后，音频推理在本机运行。使用大模型阅读转写时，内容可能发送给
DSH 配置的服务提供方；该操作受宿主配置和提供方条款约束。

## 限制

- 说话人标签用于区分同一会议中的声音，不构成个人身份识别。
  识别与说话人区分效果取决于输入条件；本项目未报告通用准确率基准。
- 三个固定模型权重目前只有一个已验证的提供方。上游故障可能阻止安装；
  不能用同名但不同字节的模型替代。
- 发送后的消息历史可能显示会议引用的内部链接，选择器与输入框仍显示会议标题。

## 开发与许可

源码构建和验证见 [开发参考](docs/development.md)，贡献要求见
[CONTRIBUTING.md](CONTRIBUTING.md)，安装包准备见
[发布参考](docs/publishing.md)。

项目自有源码使用 [Apache-2.0](LICENSE)。第三方源码与模型保留各自条款；
许可和署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、
`third_party/` 与原生模块的 vendored 目录。

## 支持与联系

- 使用问题、Bug 和功能建议：
  [GitHub Issues](https://github.com/huliux/dsh-asr-plugin/issues)。
  需要提供的诊断信息见 [支持说明](SUPPORT.md)。
- 合作与私下联系：
  [dasenrising@gmail.com](mailto:dasenrising@gmail.com)。
- 安全漏洞：请按 [安全报告说明](SECURITY.md) 私下反馈。
