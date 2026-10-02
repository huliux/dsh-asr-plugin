#ifndef CONFIG_LOADER_H
#define CONFIG_LOADER_H

#include "config_types.h"
#include <string>
#include <optional>

/**
 * 配置加载器
 *
 * 负责从 JSON 文件加载录制配置，并解析为 RecordingConfig 结构体
 *
 * 功能：
 * - 从文件路径加载 JSON 配置
 * - 解析 JSON 并填充到 RecordingConfig
 * - 处理缺失字段（使用默认值）
 * - 错误处理和验证
 *
 * 使用示例：
 * ```cpp
 * ConfigLoader loader;
 * auto config = loader.loadFromFile("configs/presets/tap-only.json");
 * if (config.has_value()) {
 *     config->print();
 * } else {
 *     std::cerr << "加载配置失败" << std::endl;
 * }
 * ```
 */
class ConfigLoader {
public:
    /**
     * 从文件加载配置
     *
     * @param filepath JSON 配置文件路径
     * @return RecordingConfig，如果加载失败则返回 std::nullopt
     */
    std::optional<RecordingConfig> loadFromFile(const std::string& filepath);

    /**
     * 从 JSON 字符串加载配置（用于测试）
     *
     * @param jsonString JSON 字符串
     * @return RecordingConfig，如果解析失败则返回 std::nullopt
     */
    std::optional<RecordingConfig> loadFromString(const std::string& jsonString);

    /**
     * 获取最后一次加载的错误信息
     * @return 错误信息字符串
     */
    std::string getLastError() const { return lastError; }

private:
    std::string lastError;  // 最后一次加载的错误信息

    /**
     * 解析 JSON 对象为 RecordingConfig
     *
     * @param j JSON 对象（nlohmann::json）
     * @return RecordingConfig，如果解析失败则返回 std::nullopt
     */
    std::optional<RecordingConfig> parseJson(const void* jsonPtr);

    /**
     * 解析 AudioSource 列表
     */
    std::optional<std::vector<AudioSource>> parseSources(const void* jsonPtr);

    /**
     * 解析 TapConfig
     */
    std::optional<TapConfig> parseTapConfig(const void* jsonPtr);

    /**
     * 解析 AggregateDeviceConfig
     */
    std::optional<AggregateDeviceConfig> parseAggregateDeviceConfig(const void* jsonPtr);

    /**
     * 解析 RecorderConfig
     */
    std::optional<RecorderConfig> parseRecorderConfig(const void* jsonPtr);

    /**
     * 解析 RuntimeConfig
     */
    std::optional<RuntimeConfig> parseRuntimeConfig(const void* jsonPtr);

    /**
     * 设置错误信息
     */
    void setError(const std::string& error) {
        lastError = error;
    }
};

#endif // CONFIG_LOADER_H
