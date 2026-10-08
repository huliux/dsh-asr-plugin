const repo = 'https://github.com/huliux/dsh-asr-plugin';
const npm = 'https://www.npmjs.com/package/@huliux/dsh-asr-plugin';
const image = (name, alt, caption) => `<figure><a href="{{root}}assets/${name}.jpg"><img src="{{root}}assets/${name}.jpg" alt="${alt}" width="1570" height="1106" loading="lazy" decoding="async"></a><figcaption>${caption}</figcaption></figure>`;
const command = (copy) => `<div class="command"><pre><code>dsh plugin --profile web add --ignore-scripts @huliux/dsh-asr-plugin@{{version}}</code></pre><button type="button" data-copy hidden aria-live="polite">${copy}</button></div>`;
const source = (path, text) => `<a href="${repo}/blob/main/${path}">${text}</a>`;

export const screenshots = ['recording-live-summary', 'recording-active', 'recording-expanded', 'meeting-summary'];
export const googleSiteVerification = 'F9EH-zLKll2Sk5245wPagM6_Vq9IZ89r4rU7uZq40Xs';

export const locales = {
  'zh-CN': {
    prefix: 'zh-CN/', other: '', otherLabel: 'English', skip: '跳至正文',
    tagline: 'DeepSeek Harness 非官方插件',
    nav: { index: '介绍', start: '快速开始', guide: '使用案例', faq: '常见问题' },
    footer: `由 <a href="https://github.com/huliux">huliux</a> 维护 · Apache-2.0<br><a href="${repo}/issues">问题反馈</a> · <a href="mailto:dasenrising@gmail.com">联系作者</a> · ${source('SECURITY.md', '安全报告')}`,
    pages: {
      index: {
        title: 'DSH 本地会议转写与 AI 总结',
        description: 'dsh-asr-plugin 是面向 Apple Silicon macOS 的 DeepSeek Harness 非官方插件，支持本地录音、音频导入、会议转写和通过会议引用生成阶段性总结。',
        body: `<p>在 Mac 上录制会议、转写音频，再在 DSH 聊天中引用会议，整理要点和行动项。</p>
<p class="muted">Apple Silicon macOS · Node.js 24 · 已验证 DSH 0.2.0-rc.2</p>
${command('复制命令')}
<p>也可以从 DSH 插件管理页面安装。首次使用需要在插件设置中下载模型。</p>
<div class="links"><a href="start.html">安装与准备</a><a href="${repo}">GitHub 源码</a><a href="${npm}">npm 包</a></div>
<h2>录音时，也能整理当前要点</h2>
<p>录音期间，用 <code>@</code> 选择当前会议，请模型总结已经出现的内容。每次请求读取当前草稿，生成一份阶段性总结；后续转写可能修订它。</p>
${image('recording-live-summary', '系统音频仍在录制，聊天中已生成当前会议草稿的阶段性总结', '真实 DSH 截图，使用虚构的语音合成会议。总结由用户请求生成，不会自动持续刷新。')}
<h2>可以做什么</h2>
<ul><li>录制麦克风、系统音频，或同时录制两条音轨。</li><li>导入 WAV、M4A、MP3，生成带时间戳和说话人标签的转写。</li><li>在聊天中引用会议，提取决定、待办、负责人和待确认事项。</li></ul>
<p><a href="guide.html">查看录音与会议总结案例</a></p>
<h2>数据如何处理</h2>
<p>模型准备完成后，音频推理在本机进行。使用在线模型阅读或总结会议时，引用的转写内容会发送给 DSH 中配置的模型提供商。</p>
<p>目前不支持 Windows、Linux 和 Intel Mac。说话人标签用于区分会议中的声音，不代表已识别真实身份。</p>`
      },
      start: {
        title: '安装与第一次转写',
        description: '在 Apple Silicon Mac 上安装 dsh-asr-plugin：检查 DSH 和 Node.js 版本，下载转写模型，设置录音权限并生成第一份会议总结。',
        body: `<h2>1. 检查运行环境</h2>
<p>使用 Apple Silicon Mac、Node.js 24。当前验证的宿主版本为 DSH 0.2.0-rc.2。</p>
<p>麦克风 API 需要 macOS 13.5 或以上；系统音频及双轨 API 需要 macOS 14.2 或以上。这些是 API 要求，不代表所有系统版本均已测试。桌面和 Web 模式都在运行 DSH 的 Mac 上处理音频。</p>
<h2>2. 安装插件</h2>
<p>在 DSH 插件管理页面安装 <code>@huliux/dsh-asr-plugin</code>。使用 Web 配置时，也可执行：</p>
${command('复制命令')}
<p>该命令针对名为 <code>web</code> 的配置。按你的实际使用方式选择配置，安装后在 DSH 插件设置中检查状态。</p>
<p>npm 包已经包含编译后的原生组件和采用 ad-hoc 签名的录音 Helper。Helper 尚未公证，安装或更新后 macOS 可能要求权限或安全批准，请保持系统安全保护开启。</p>
<h2>3. 准备模型</h2>
<p>在插件设置中下载基础模型，约 278 MiB。可选标点模型约 274 MiB，安装验证通过后自动用于新的录音、导入和重新转写。</p>
<p>模型单独下载，不包含在 npm 或 Release 安装包中。启用插件不会自动开始下载。下载失败可重试；离线准备和来源说明见 ${source('docs/model-assets.md', '模型文档')}。</p>
<h2>4. 检查录音权限</h2>
<p>在插件设置的“录音权限”中检查麦克风和系统音频访问。录制系统音频时，检查系统输出设备、音量和权限；一次检查失败不一定表示权限被拒绝。</p>
<h2>5. 完成第一次会议总结</h2>
<ol><li>选择一个 DSH 会话，展开录音组件并开始录制。</li><li>录音结束后等待转写完成。</li><li>在聊天输入框使用 <code>@</code> 选择这场会议。</li><li>发送：请总结这场会议的决定、行动项、负责人、期限和待确认问题；未明确的信息请标注待确认。</li></ol>
<p>也可以请 DSH 导入本地音频的绝对路径，支持 WAV、M4A 和 MP3。录音期间的总结方法见 <a href="guide.html">使用案例</a>。</p>
<p>桌面与 Web 配置默认共享会议存储。同一数据目录只运行一个插件宿主；更新包时保留已有会议和模型数据。</p>
<p>离线安装、包校验和源码构建见 ${source('docs/distribution.md', '分发文档')}。</p>`
      },
      guide: {
        title: '录音、阶段性总结与会后行动项',
        description: 'dsh-asr-plugin 的真实 DSH 使用案例：查看紧凑录音组件、展开实时草稿，在录音期间引用会议生成总结，并在会后提取行动项。',
        body: `<p>以下截图来自插件 0.1.2、DSH 0.2.0-rc.2、Node.js 24.18.0 和 Apple Silicon macOS 26.7，拍摄于 2026-10-08。演示使用虚构的语音合成会议，不包含真实会议资料，也不构成通用准确率测试。</p>
<h2>开始录音</h2>
<p>选择 DSH 会话后开始录音。紧凑组件显示录音状态和控制按钮；根据实际会议选择麦克风、系统音频或双轨。</p>
${image('recording-active', '正在录音的紧凑组件，系统音频开启、麦克风关闭', '截图中系统音频正在录制，麦克风关闭；输入框里的提示尚未发送。')}
<h2>展开录音组件</h2>
<p>展开后可以查看已录时长、音轨状态和当前转写草稿。仅展开组件会准备模型，不会开始采集音频。录音中的文本是可修订草稿。</p>
${image('recording-expanded', '展开的录音组件显示时长、音轨和实时转写草稿', '同一段虚构音频通过 Mac 系统输出播放，并由插件实际录制。')}
<h2>边录边请求总结</h2>
<p>在聊天中用 <code>@</code> 选择正在录制的会议，然后发送：</p>
<pre><code>请读取这场会议的当前草稿，整理截至目前明确的决定、行动项和待确认问题。
只列出明确提到的负责人和期限，不要根据说话人标签推断姓名。
标注这是录音中的阶段性总结，后续可能变化。</code></pre>
<p>模型读取当前草稿并生成快照。需要更新时，再次发送请求。它不是自动持续刷新，也不等同于录音结束后的最终转写。</p>
<p><a href="index.html#live-example">查看录音期间已生成总结的截图</a></p>
<h2>录音结束后提取行动项</h2>
<p>等待会议转写完成，再用 <code>@</code> 引用会议，请模型基于已提交的转写提取行动项：</p>
<pre><code>请阅读完整会议转写，列出决定、任务、负责人、期限和待确认问题。
未明确的负责人或日期请写“待确认”，不要补全。</code></pre>
${image('meeting-summary', '引用已完成的会议后，聊天显示决定与行动项总结', '此截图使用导入的 56.6 秒虚构音频，插件生成 22 段转写和两个说话人标签。')}
<p>总结结果仍需人工核对。语音转写在本地进行；这里的总结示例使用配置的 DeepSeek 模型，引用的转写发送至该提供商。</p>
<p>完整截图与证据边界见 ${source('assets/screenshots/README.md', '截图说明')}；也可阅读 <a href="https://github.com/deepseek-ai/deepseek-harness/discussions/9125">官方社区中的项目展示</a>。</p>`
      },
      faq: {
        title: '常见问题',
        description: '了解 dsh-asr-plugin 的平台限制、本地转写与在线总结的数据处理、模型下载、录音权限、说话人标签和更新注意事项。',
        body: `<h2>哪些平台可以使用？</h2><p>目前面向 Apple Silicon macOS，使用 Node.js 24，已验证 DSH 0.2.0-rc.2。Windows、Linux 和 Intel Mac 不支持。API 系统要求见 <a href="start.html">快速开始</a>。</p>
<h2>这是 DeepSeek 官方插件吗？</h2><p>不是。这是 huliux 维护的开源社区插件，与 DeepSeek 官方产品支持范围独立。</p>
<h2>会议数据会离开本机吗？</h2><p>模型准备后，音频推理在本机进行。使用在线 LLM 阅读或总结会议时，引用的转写内容会发送给 DSH 配置的模型提供商，其配置和条款适用于该操作。</p>
<h2>为什么安装后还需要下载模型？</h2><p>安装包包含运行代码、原生组件和录音 Helper，不包含模型权重。基础模型约 278 MiB；可选标点模型约 274 MiB。模型按固定上游版本下载并检查大小和 SHA-256。离线准备见 ${source('docs/model-assets.md', '模型文档')}。</p>
<h2>总结会随着录音自动更新吗？</h2><p>不会自动持续刷新。每次请求生成当前草稿的阶段性总结，需要更新时再次请求。草稿可以修订；会后请基于完成的转写重新核对。</p>
<h2>说话人标签能识别参与者姓名吗？</h2><p>标签区分同一会议中的声音，不建立真实身份或跨会议身份。总结时不要让模型根据标签猜测姓名。</p>
<h2>系统音频录制检查失败怎么办？</h2><p>在插件设置中检查“录音权限”，并核对 macOS 权限、输出设备、音量和音频路由。检查失败可能来自权限或路由；录制时的静音也不等于权限被拒绝。Helper 尚未公证，更新后可能需要重新批准权限，请保持系统保护开启。</p>
<h2>转写速度和准确率怎样？</h2><p>表现取决于设备、音频长度、噪声和说话条件。本项目没有发布通用准确率基准；演示截图不能代表所有会议的识别效果。</p>
<h2>更新会影响会议数据吗？</h2><p>替换包时保留已有会议和模型数据。同一数据目录只运行一个插件宿主，默认桌面和 Web 配置共享存储。具体安装路径和校验方法见 ${source('docs/distribution.md', '分发文档')}。</p>
<h2>在哪里反馈问题？</h2><p>使用 <a href="${repo}/issues">GitHub Issues</a>，附插件、DSH、Node.js 和 macOS 版本及不含会议内容的诊断信息。合作或私密咨询可邮件联系 <a href="mailto:dasenrising@gmail.com">dasenrising@gmail.com</a>；漏洞请遵循 ${source('SECURITY.md', '安全报告流程')}。</p>`
      }
    }
  },
  en: {
    prefix: '', other: 'zh-CN/', otherLabel: '简体中文', skip: 'Skip to content',
    tagline: 'Unofficial DeepSeek Harness plugin',
    nav: { index: 'About', start: 'Get started', guide: 'Workflows', faq: 'FAQ' },
    footer: `Maintained by <a href="https://github.com/huliux">huliux</a> · Apache-2.0<br><a href="${repo}/issues">Report an issue</a> · <a href="mailto:dasenrising@gmail.com">Contact</a> · ${source('SECURITY.md', 'Security reports')}`,
    pages: {
      index: {
        title: 'Local meeting transcription for DSH',
        description: 'dsh-asr-plugin is an unofficial DeepSeek Harness plugin for Apple Silicon macOS. Record or import audio, transcribe locally, and reference meetings for AI summaries and action items.',
        body: `<p>Record meetings on your Mac, transcribe audio locally, then reference a meeting in DSH to summarize decisions and action items.</p>
<p class="muted">Apple Silicon macOS · Node.js 24 · Verified with DSH 0.2.0-rc.2</p>
${command('Copy command')}
<p>You can also install from the DSH Plugins page. Download the models in plugin settings before your first transcription.</p>
<div class="links"><a href="start.html">Installation guide</a><a href="${repo}">GitHub source</a><a href="${npm}">npm package</a></div>
<h2>Summarize what has been said so far</h2>
<p>While recording, use <code>@</code> to select the current meeting and request a summary. Each request reads the live draft and produces an interim snapshot. Later transcription may revise it.</p>
${image('recording-live-summary', 'System audio recording continues while DSH displays an interim summary from the meeting draft', 'Actual DSH screenshot using a fictional, speech-synthesized meeting. The summary is requested by the user and does not refresh automatically.')}
<h2>What you can do</h2>
<ul><li>Record microphone audio, system audio, or both tracks.</li><li>Import WAV, M4A and MP3 files for transcripts with timestamps and speaker labels.</li><li>Reference a meeting in chat to extract decisions, tasks, owners and open questions.</li></ul>
<p><a href="guide.html">See the recording and summary workflows</a></p>
<h2>How data is processed</h2>
<p>Audio inference runs locally after model preparation. Reading or summarizing a meeting with an online LLM sends the referenced transcript to the provider configured in DSH.</p>
<p>Windows, Linux and Intel Macs are unsupported. Speaker labels distinguish voices within a meeting; they do not establish personal identity.</p>`
      },
      start: {
        title: 'Installation and your first transcript',
        description: 'Install dsh-asr-plugin on an Apple Silicon Mac: check DSH and Node.js versions, download models, check recording permissions, and summarize your first meeting.',
        body: `<h2>1. Check the environment</h2><p>Use an Apple Silicon Mac and Node.js 24. The verified host version is DSH 0.2.0-rc.2.</p>
<p>Microphone APIs require macOS 13.5 or later; system audio and dual-track APIs require macOS 14.2 or later. These are API requirements, not a tested OS matrix. Desktop and Web modes both process audio on the Mac running DSH.</p>
<h2>2. Install the plugin</h2><p>Install <code>@huliux/dsh-asr-plugin</code> from the DSH Plugins page. For a Web profile, you can also run:</p>
${command('Copy command')}
<p>This command targets the profile named <code>web</code>. Choose the profile appropriate to your setup, then check plugin settings in DSH.</p>
<p>The npm package contains compiled native components and an ad-hoc signed recording Helper. The Helper is not notarized; macOS may request permission or security approval after installation or updates. Keep system protections enabled.</p>
<h2>3. Prepare models</h2><p>Download base models in plugin settings, approximately 278 MiB. Optional punctuation models require approximately 274 MiB and apply to new recordings, imports and retranscriptions after verified installation.</p>
<p>Models are separate from npm and Release packages. Enabling the plugin does not start a download. Failed downloads can be retried; see ${source('docs/model-assets.md', 'model assets')} for sources and offline staging.</p>
<h2>4. Check recording permissions</h2><p>Use “Recording permissions” in settings to check microphone and system-audio access. For system audio, check the output device, volume and permissions. A failed check does not necessarily mean access was denied.</p>
<h2>5. Summarize your first meeting</h2><ol><li>Select a DSH session, expand the recorder and start recording.</li><li>Stop recording and wait for transcription to complete.</li><li>Use <code>@</code> in chat to select the meeting.</li><li>Ask for decisions, tasks, owners, deadlines and open questions. Request that unspecified information be marked as unknown.</li></ol>
<p>You can also ask DSH to import an absolute local path to a WAV, M4A or MP3 file. See <a href="guide.html">workflows</a> for summaries during recording.</p>
<p>Desktop and Web profiles share the default meeting store. Run one plugin host per data directory. Preserve meeting and model data when replacing a package.</p>
<p>See ${source('docs/distribution.md', 'distribution')} for archive installation, checksums and source builds.</p>`
      },
      guide: {
        title: 'Recording, interim summaries and action items',
        description: 'Actual DSH workflows with dsh-asr-plugin: compact recording controls, expanded transcript drafts, user-requested summaries during recording, and action items after transcription.',
        body: `<p>These screenshots show plugin 0.1.2, DSH 0.2.0-rc.2, Node.js 24.18.0 and Apple Silicon macOS 26.7 on 2026-10-08. The meeting is fictional and speech-synthesized. It contains no real meeting data and is not an accuracy benchmark.</p>
<h2>Start a recording</h2><p>Select a DSH session and start recording. The compact recorder shows capture status and controls. Choose microphone, system audio or both for your meeting.</p>
${image('recording-active', 'Compact recording controls with system audio active and microphone disabled', 'Actual system-audio recording. The prompt in the composer has not been sent.')}
<h2>Expand the recorder</h2><p>View elapsed time, track states and the live draft transcript. Expansion alone prepares models without capturing audio. Text during recording is provisional and may be revised.</p>
${image('recording-expanded', 'Expanded recorder showing elapsed time, audio tracks and a live transcript draft', 'The plugin records fictional audio played through the Mac system output.')}
<h2>Request a summary while recording</h2><p>Select the ongoing meeting with <code>@</code> and send:</p>
<pre><code>Read the current meeting draft. Summarize explicit decisions, action items and open questions so far.
Only include owners and deadlines that were actually stated. Do not infer names from speaker labels.
Mark this as an interim summary that may change while recording continues.</code></pre>
<p>The model reads the current draft and produces a snapshot. Send another request when you want an update. It does not refresh continuously and is separate from the completed transcript.</p>
<p><a href="index.html#live-example">See a summary generated while recording continues</a></p>
<h2>Extract action items after transcription</h2><p>Once the meeting finishes processing, reference it with <code>@</code> and ask:</p>
<pre><code>Read the complete transcript. List decisions, tasks, owners, deadlines and open questions.
Mark unstated owners or dates as unknown; do not fill them in.</code></pre>
${image('meeting-summary', 'DSH summarizes decisions and action items from a completed meeting reference', 'This example imports a 56.6-second fictional recording, producing 22 transcript segments and two speaker labels.')}
<p>Review summaries against the transcript. Audio inference is local; this example sends the referenced transcript to the configured DeepSeek model for summary.</p>
<p>See ${source('assets/screenshots/README.md', 'screenshot details')} for the full gallery and evidence boundaries, or the <a href="https://github.com/deepseek-ai/deepseek-harness/discussions/9125">official community showcase</a>.</p>`
      },
      faq: {
        title: 'Frequently asked questions',
        description: 'Platform support, local transcription and online summaries, model downloads, recording permissions, speaker labels and updates for the dsh-asr-plugin community plugin.',
        body: `<h2>Which platforms are supported?</h2><p>Apple Silicon macOS with Node.js 24; verified with DSH 0.2.0-rc.2. Windows, Linux and Intel Macs are unsupported. See <a href="start.html">getting started</a> for API system requirements.</p>
<h2>Is this an official DeepSeek plugin?</h2><p>No. This open-source community plugin is maintained by huliux, independently of DeepSeek's official product support.</p>
<h2>Does meeting data leave my Mac?</h2><p>Audio inference runs locally after model preparation. Reading or summarizing a meeting with an online LLM sends the referenced transcript to DSH's configured provider. Host configuration and provider terms govern that operation.</p>
<h2>Why do I need a separate model download?</h2><p>Packages contain runtime code, native components and the recording Helper, but no weights. Base models are approximately 278 MiB; optional punctuation models are approximately 274 MiB. Downloads use pinned upstream revisions with size and SHA-256 checks. See ${source('docs/model-assets.md', 'model assets')} for offline staging.</p>
<h2>Do summaries update automatically during recording?</h2><p>No. Each request produces an interim snapshot of the current draft. Request another summary when needed. Drafts may be revised; review the completed transcript after recording.</p>
<h2>Can speaker labels identify participants?</h2><p>They distinguish voices within a meeting, not personal or cross-meeting identities. Do not ask a model to infer names from these labels.</p>
<h2>What if the system-audio check fails?</h2><p>Check “Recording permissions” in settings, macOS permissions, the output device, volume and routing. Failure may reflect permission or routing. Silence during recording does not establish permission denial. The Helper is not notarized; updates may require approval again. Keep system protections enabled.</p>
<h2>How fast and accurate is transcription?</h2><p>Results depend on hardware, duration, noise and speech conditions. No general accuracy benchmark is reported. Demo screenshots do not establish performance for other meetings.</p>
<h2>What should I preserve during an update?</h2><p>Preserve meeting and model data when replacing a package. Run one plugin host per data directory; Desktop and Web profiles share the default store. See ${source('docs/distribution.md', 'distribution')} for installation and verification.</p>
<h2>Where can I ask for help?</h2><p>Use <a href="${repo}/issues">GitHub Issues</a> with plugin, DSH, Node.js and macOS versions and content-free diagnostics. Contact <a href="mailto:dasenrising@gmail.com">dasenrising@gmail.com</a> for private inquiries or collaboration. Follow ${source('SECURITY.md', 'the security policy')} for vulnerabilities.</p>`
      }
    }
  }
};
