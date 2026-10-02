#include "recorder_config.h"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <chrono>
#include <algorithm>
#include <cctype>

// 验证配置有效性
bool RecorderConfig::isValid() const {
    // 1. 检查 outputBasePath 不为空
    if (outputBasePath.empty()) {
        std::cerr << "RecorderConfig 验证失败: outputBasePath 不能为空" << std::endl;
        return false;
    }

    // 2. 检查路径中不包含非法字符（基本检查）
    // macOS 文件名不能包含 : 和 /（除非是路径分隔符）
    // 这里只做简单检查，实际文件创建时由系统进行完整验证
    size_t lastSlash = outputBasePath.find_last_of('/');
    std::string filename = (lastSlash != std::string::npos)
                               ? outputBasePath.substr(lastSlash + 1)
                               : outputBasePath;

    if (filename.find(':') != std::string::npos) {
        std::cerr << "RecorderConfig 验证失败: 文件名不能包含 ':' 字符" << std::endl;
        return false;
    }

    // 3. 检查输出格式
    if (outputFormat != OutputFileFormat::Caf && outputFormat != OutputFileFormat::Wav) {
        std::cerr << "RecorderConfig 验证失败: 不支持的输出格式" << std::endl;
        return false;
    }

    // 4. 检查输出采样率（允许 0 表示使用设备原生）
    if (outputSampleRate < 0.0) {
        std::cerr << "RecorderConfig 验证失败: outputSampleRate 不能为负数" << std::endl;
        return false;
    }

    // 5. 检查输出位深（允许 0 表示使用设备原生）
    if (outputBitsPerSample < 0 || (outputBitsPerSample > 0 && outputBitsPerSample % 8 != 0)) {
        std::cerr << "RecorderConfig 验证失败: outputBitsPerSample 必须为 8 的倍数" << std::endl;
        return false;
    }

    // 6. 检查输出声道数（允许 0 表示使用设备原生）
    if (outputChannels < 0) {
        std::cerr << "RecorderConfig 验证失败: outputChannels 不能为负数" << std::endl;
        return false;
    }

    // 7. 检查分块大小（允许 0 表示不分块）
    if (chunkSizeSeconds < 0.0) {
        std::cerr << "RecorderConfig 验证失败: chunkSizeSeconds 不能为负数" << std::endl;
        return false;
    }

    return true;
}

// 打印配置（用于调试）
void RecorderConfig::print() const {
    std::cout << "=== RecorderConfig ===" << std::endl;
    std::cout << "  outputBasePath: " << outputBasePath << std::endl;
    std::cout << "  separateStreams: " << (separateStreams ? "true" : "false") << std::endl;
    std::cout << "  timestampInFilename: " << (timestampInFilename ? "true" : "false") << std::endl;
    std::cout << "  fileNamePattern: " << fileNamePattern << std::endl;
    std::cout << "  modeLabel: " << modeLabel << std::endl;
    std::cout << "  outputFormat: " << (outputFormat == OutputFileFormat::Wav ? "wav" : "caf") << std::endl;
    std::cout << "  outputSampleRate: " << outputSampleRate << std::endl;
    std::cout << "  outputBitsPerSample: " << outputBitsPerSample << std::endl;
    std::cout << "  outputChannels: " << outputChannels << std::endl;
    std::cout << "  outputFloat: " << (outputFloat ? "true" : "false") << std::endl;
    std::cout << "  chunkSizeSeconds: " << chunkSizeSeconds << std::endl;
    std::cout << "  sourceLabel: " << sourceLabel << std::endl;
    std::cout << "======================" << std::endl;
}

// 生成完整的输出文件路径 (Phase 3A.4 扩展)
std::string RecorderConfig::generateOutputPath(int streamIndex, const std::string& processName) const {
    const char* extension = (outputFormat == OutputFileFormat::Wav) ? ".wav" : ".caf";

    // 如果使用新的语义化命名模板 (Phase 3A.4)
    if (!fileNamePattern.empty() && fileNamePattern.find("{") != std::string::npos) {
        // 确定音频源标识: 0=mic, 1=tap
        std::string source = (streamIndex == 0) ? "mic" : "tap";

        // 获取时间戳
        std::string timestamp = getCurrentTimestamp();

        // 替换模板变量
        std::string fileName = replaceTemplateVariables(fileNamePattern, modeLabel, source, timestamp);

        // 构建完整路径：基础路径 + 文件名 + 扩展名
        std::string fullPath = outputBasePath;

        // 确保基础路径以 / 结尾
        if (!fullPath.empty() && fullPath.back() != '/') {
            fullPath += "/";
        }

        fullPath += fileName + extension;

        return fullPath;
    }

    // 向后兼容: 使用旧版命名逻辑
    std::ostringstream oss;
    oss << outputBasePath;

    // 添加时间戳（如果启用）
    if (timestampInFilename) {
        auto now = std::chrono::system_clock::now();
        auto time_t = std::chrono::system_clock::to_time_t(now);
        auto tm = *std::localtime(&time_t);

        oss << "_" << std::put_time(&tm, "%Y-%m-%d_%H-%M-%S");  // 已包含秒
    }

    // 添加流索引（如果启用分离流）
    if (separateStreams) {
        oss << "_Stream_" << streamIndex;
    }

    // 添加文件扩展名
    oss << extension;

    return oss.str();
}

// 规范化应用名称 (Phase 3A.4)
std::string RecorderConfig::normalizeAppName(const std::string& processName) const {
    if (processName.empty()) {
        return "unknown";
    }

    std::string result = processName;

    // 移除常见后缀 (如 "Helper", "Renderer" 等)
    const std::string suffixes[] = {" Helper", " Renderer", " (GPU)", " (Plugin)", ".app"};
    for (const auto& suffix : suffixes) {
        size_t pos = result.find(suffix);
        if (pos != std::string::npos) {
            result = result.substr(0, pos);
        }
    }

    // 提取核心应用名 (去除前缀,如 "Google Chrome" → "Chrome")
    // 处理常见模式: "品牌 应用名"
    size_t spacePos = result.find(' ');
    if (spacePos != std::string::npos && spacePos < result.length() - 1) {
        // 如果有空格且后面还有内容,取后半部分
        // 例外: 如果只有一个词,保留整个
        std::string secondPart = result.substr(spacePos + 1);
        if (!secondPart.empty() && secondPart.length() > 2) {
            result = secondPart;
        }
    }

    // 转换为小写
    std::transform(result.begin(), result.end(), result.begin(), ::tolower);

    // 移除所有空格和特殊字符,只保留字母和数字
    result.erase(
        std::remove_if(result.begin(), result.end(),
                      [](char c) { return !std::isalnum(c); }),
        result.end()
    );

    // 如果结果为空,返回 "unknown"
    return result.empty() ? "unknown" : result;
}

// 获取当前时间戳 (Phase 3A.4)
std::string RecorderConfig::getCurrentTimestamp() const {
    auto now = std::chrono::system_clock::now();
    auto time_t = std::chrono::system_clock::to_time_t(now);
    auto tm = *std::localtime(&time_t);

    std::ostringstream oss;
    oss << std::put_time(&tm, "%Y%m%d_%H%M%S");  // YYYYMMDD_HHMMSS 格式（精确到秒）
    return oss.str();
}

// 替换模板变量 (Phase 3A.4)
std::string RecorderConfig::replaceTemplateVariables(
    const std::string& pattern,
    const std::string& mode,
    const std::string& source,
    const std::string& timestamp) const {

    std::string result = pattern;

    // 替换 {mode}
    size_t pos = result.find("{mode}");
    if (pos != std::string::npos) {
        result.replace(pos, 6, mode);
    }

    // 替换 {source}
    pos = result.find("{source}");
    if (pos != std::string::npos) {
        result.replace(pos, 8, source);
    }

    // 替换 {timestamp}
    pos = result.find("{timestamp}");
    if (pos != std::string::npos) {
        result.replace(pos, 11, timestamp);
    }

    return result;
}
