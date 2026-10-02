#ifndef RECORDER_CONFIG_H
#define RECORDER_CONFIG_H

#include <string>

/**
 * 输出文件格式
 */
enum class OutputFileFormat {
    Caf,
    Wav
};

/**
 * 音频录制器配置
 *
 * 对齐 Apple 官方示例 (CapturingSystemAudioWithCoreAudioTaps) 的 AudioRecorder 行为
 *
 * 参考：
 * - AudioRecorder.mm: AudioRecorder::catalogDeviceStreams()
 * - AudioRecorder.mm: AudioRecorder::makeRecordingFiles()
 *
 * 核心设计原则：
 * 【使用设备原生格式】
 * Apple 的 AudioRecorder 通过 kAudioStreamPropertyVirtualFormat 读取设备的原生音频格式
 * 不进行手动的格式配置（如采样率、位深度、声道数等）
 *
 * AudioRecorder.mm line 173:
 * ```
 * address = PropertyAddress(kAudioStreamPropertyVirtualFormat);
 * AudioStreamBasicDescription format;
 * AudioObjectGetPropertyData(streamID, &address, 0, nullptr, &size, &format);
 * ```
 *
 * 因此，本配置结构体**不包含**音频格式配置字段（sampleRate, channels, bitsPerChannel 等）
 * 这些参数将在运行时从设备读取
 *
 * 配置字段：
 * - outputBasePath: 输出文件基础路径（不含扩展名）
 * - separateStreams: 是否为每个输入流创建独立文件
 * - timestampInFilename: 是否在文件名中添加时间戳
 */
struct RecorderConfig {
    /**
     * 输出文件基础路径（不含扩展名）
     * 默认值："output"
     *
     * 说明：
     * - 相对路径：相对于当前工作目录或沙箱容器
     * - 绝对路径：完整的文件系统路径
     * - 实际文件名会根据其他配置参数生成，例如：
     *   - 单流: output.caf
     *   - 多流: output_Stream_0.caf, output_Stream_1.caf
     *   - 带时间戳: output_2025-11-04_14-30-00.caf
     */
    std::string outputBasePath = "output";

    /**
     * 是否为每个输入流创建独立文件
     * 默认值：false
     *
     * 说明：
     * - false: 所有流混合到单个文件（适合大多数场景）
     * - true: 每个输入流生成独立文件（适合需要分离麦克风和 Tap 音频的场景）
     *
     * 文件命名规则（separateStreams=true）：
     * - <basePath>_Stream_0.caf  // 第一个输入流（通常是麦克风，1 声道）
     * - <basePath>_Stream_1.caf  // 第二个输入流（通常是 Tap，2 声道）
     *
     * 对应 Apple AudioRecorder 的多流录制支持
     */
    bool separateStreams = false;

    /**
     * 是否在文件名中添加时间戳
     * 默认值：false
     *
     * 说明：
     * - false: 使用原始基础路径（如 output.caf）
     * - true: 添加时间戳（如 output_2025-11-04_14-30-00.caf）
     *
     * 时间戳格式：YYYY-MM-DD_HH-MM-SS（ISO 8601 简化格式）
     *
     * 对应 Apple AudioRecorder 的文件命名行为
     */
    bool timestampInFilename = false;

    /**
     * 文件命名模板 (Phase 3A.4)
     * 默认值: "{mode}_{source}_{timestamp}"
     *
     * 支持的模板变量:
     * - {mode}: 模式标识 (system 或应用标识如 wechat)
     * - {source}: 音频源 (mic 或 tap)
     * - {timestamp}: 时间戳 (YYYYMMDD_HHMM)
     *
     * 说明:
     * 本字段用于生成语义化文件名,区分全局/指定模式和麦克风/Tap音频源
     * 例如: system_mic_20251105_1830.caf, wechat_tap_20251105_1830.caf
     */
    std::string fileNamePattern = "{mode}_{source}_{timestamp}";

    /**
     * 模式标识符 (Phase 3A.4)
     * 默认值: "system"
     *
     * 说明:
     * - "system": 全局录制模式 (多个进程或无指定进程)
     * - 应用标识: 指定录制模式 (从进程名提取,如 "wechat", "chrome")
     *
     * 由 RecordingEngine 根据配置自动设置
     */
    std::string modeLabel = "system";

    /**
     * 输出文件格式
     * 默认值：Caf（保持现有 audio-native 行为）
     */
    OutputFileFormat outputFormat = OutputFileFormat::Caf;

    /**
     * 输出采样率（Hz）
     * 默认值：0（使用设备原生采样率）
     */
    double outputSampleRate = 0.0;

    /**
     * 输出位深（bit）
     * 默认值：0（使用设备原生位深）
     */
    int outputBitsPerSample = 0;

    /**
     * 输出声道数
     * 默认值：0（使用设备原生声道数）
     */
    int outputChannels = 0;

    /**
     * 输出是否为浮点格式
     * 默认值：false（整数 PCM）
     */
    bool outputFloat = false;

    /**
     * 分块大小（秒）
     * 默认值：0（不分块）
     */
    double chunkSizeSeconds = 0.0;

    /**
     * 分块命名用的音频来源标识（mic/system）
     * 默认值：空（不启用分块命名）
     */
    std::string sourceLabel;

    // 验证配置有效性
    bool isValid() const;

    // 打印配置（用于调试）
    void print() const;

    /**
     * 生成完整的输出文件路径 (Phase 3A.4 扩展)
     *
     * @param streamIndex 流索引 (0=mic, 1=tap)
     * @param processName 进程名 (可选,用于提取应用标识符)
     * @return 完整的输出文件路径 (含扩展名 .caf)
     *
     * 示例 (新版语义化命名):
     * - modeLabel="system", streamIndex=0, timestamp="20251105_1830"
     *   → "system_mic_20251105_1830.caf"
     *
     * - modeLabel="wechat", streamIndex=1, timestamp="20251105_1830"
     *   → "wechat_tap_20251105_1830.caf"
     *
     * 向后兼容 (当 fileNamePattern 为空或使用旧配置时):
     * - outputBasePath="output", separateStreams=false, timestampInFilename=false
     *   → "output.caf"
     */
    std::string generateOutputPath(int streamIndex = 0, const std::string& processName = "") const;

private:
    /**
     * 规范化应用名称 (Phase 3A.4)
     *
     * 从进程名提取应用标识符,进行规范化处理:
     * - 提取核心应用名 (去除 "Helper" 等后缀)
     * - 转换为小写
     * - 移除空格和特殊字符
     *
     * @param processName 进程名
     * @return 规范化后的应用标识符
     *
     * 示例:
     * - "WeChat Helper" → "wechat"
     * - "Google Chrome" → "chrome"
     * - "Music" → "music"
     * - "" → "unknown"
     */
    std::string normalizeAppName(const std::string& processName) const;

    /**
     * 获取当前时间戳 (Phase 3A.4)
     *
     * @return 格式为 YYYYMMDD_HHMM 的时间戳字符串
     *
     * 示例: "20251105_1830"
     */
    std::string getCurrentTimestamp() const;

    /**
     * 替换模板变量 (Phase 3A.4)
     *
     * @param pattern 命名模板 (如 "{mode}_{source}_{timestamp}")
     * @param mode 模式标识 (如 "system" 或 "wechat")
     * @param source 音频源标识 (如 "mic" 或 "tap")
     * @param timestamp 时间戳 (如 "20251105_1830")
     * @return 替换后的文件名 (不含扩展名)
     *
     * 示例:
     * - pattern="{mode}_{source}_{timestamp}", mode="system", source="mic", timestamp="20251105_1830"
     *   → "system_mic_20251105_1830"
     */
    std::string replaceTemplateVariables(
        const std::string& pattern,
        const std::string& mode,
        const std::string& source,
        const std::string& timestamp) const;
};

#endif // RECORDER_CONFIG_H
