# dsh-asr-plugin

[English](README.md) | 简体中文

面向 Apple Silicon macOS 的 DeepSeek Harness 本地会议转写插件。支持导入
WAV/M4A/MP3、录制麦克风与系统音频，生成时间戳和说话人标签，并在 DSH 中
显式引用会议，交给 Agent 阅读或导出。

**预览版：**实验版本使用 npm 的 `next` 标签，可用版本以仓库 Release 页面为准。
已知限制见下文。已验收宿主为 DSH 0.2.0-rc.2，插件要求 Node 24 运行环境。
麦克风所需系统 API 最低为 macOS 13.5，系统音频为 14.2；不代表所有系统版本均已验收。

## 安装与首次使用

在 DSH 原生 Plugins 页面安装 `@huliux/dsh-asr-plugin@next`，或通过 profile CLI
指定已发布的精确版本。也可使用已核验校验值的本地发布包：

```sh
dsh plugin --profile PROFILE add --ignore-scripts @huliux/dsh-asr-plugin@VERSION
# 备用：已校验的发布包。
dsh plugin --profile PROFILE add --ignore-scripts /absolute/path/plugin.tgz
```

预构建插件包含 FBank、hcluster 与临时签名录音 Helper，普通用户无需编译，
也不需要 Python 或 Homebrew。npm 运行依赖由 DSH 安装机制获取。模型独立交付：
基础模型约 278 MiB，必须安装；标点模型约 274 MiB，可选，不安装仍可录音和转写。

在 DSH 原生 Plugins 页面打开插件配置，点击“下载基础模型”。页面显示已下载字节、百分比、校验及安装状态，可取消、重试，重新打开仍能查看宿主任务。标点模型单独按需下载。

优先使用已验证的国内直连源，再尝试可用的其它直连源。“代理”默认选择 hf-mirror.com，仅在直连失败后使用，也可填写自定义 HTTP/HTTPS 代理。修改后保存再下载；来源覆盖与代理限制见 [model assets](docs/model-assets.md)。

模型直接从固定版本的 ModelScope/Hugging Face 来源下载，GitHub Release 不包含模型权重。
下载按大小及 SHA-256 校验后安装；仅启用插件不会自动下载。安装标点模型后仍需显式启用并保存；未安装或损坏时不能启用。设置仅影响新任务，已有原稿保持原模式。开发者也可手动导入已校验归档，见 [model assets](docs/model-assets.md)。

Helper 未公证。首次录音遵循 macOS 提示，分别允许麦克风与系统音频；更新后
可能需要重新授权。请保留系统全局保护。

若出现“尚未收到系统声音”，先播放电脑音频；自然静音并不等于权限拒绝。
若播放后仍无声音，在“系统设置 → 隐私与安全性 → 录屏与系统录音 → 仅系统录音”
开启 DSH 录音助手（部分系统缓存显示 `DSHASRRecordingHelper`）。按 macOS 提示退出/重开，
然后将插件的系统音频按钮关闭再开启，或停止后重试。麦克风权限在“麦克风”页单独开启。
首次下载放行与权限行为只以实际安装路径和对应 macOS 的验收为准。

创建或选择 DSH 会话，开始录音，或要求 Agent 导入本机绝对路径的音频。在输入框
通过原生 `@` 选择会议，要求 Agent 阅读、比较或导出；文件写入使用 DSH 审批。
会议是插件全局事实，不随会话或工作区删除。模型准备后音频处理在本机进行；
使用大模型时遵循宿主所选服务与策略。

## 预览版已知限制

- 三个固定模型权重尚无完整的跨站备用源。现有来源可用，但上游故障时可能需要稍后重试，
  或自行构建匹配的本地归档；不能替换为同名但不同权重。
- 发送后的历史消息可能显示会议引用的内部链接。选择器与输入框仍显示
会议名称，引用交付的会议 ID 保持正确。友好历史呈现需要宿主提供扩展能力；源码可用
不代表该限制已解决。

## 构建与贡献

源码构建需要 Node 24、锁定的 pnpm 和 Apple Command Line Tools。目前 native
可复现哈希基于 Apple clang 17 / macOS SDK 26，先核对工具链，勿绕过哈希门。

```sh
pnpm install --frozen-lockfile
pnpm run check
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm run build:closed-pilot
pnpm pack --pack-destination /path/to/output
```

`build:closed-pilot` 保留历史名称，但已从本仓源码重建 native/Helper、逐层临时签名
并核验解包制品。不需要 Developer ID 凭据、模型权重或私有 staging；普通 TypeScript
构建不产生完整录音包。工具链变更须重新验收 native。

开发与贡献指引使用英文：见 [development](docs/development.md)、[AGENTS.md](AGENTS.md)、
[CONTEXT.md](CONTEXT.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。项目免费、按能力维护，
不承诺响应时限或持续维护。项目自有源码为 Apache-2.0；第三方条款、署名和修改声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、`third_party/` 和 native vendored 源码。
生成的二进制、模型与私人数据不进入 Git。
