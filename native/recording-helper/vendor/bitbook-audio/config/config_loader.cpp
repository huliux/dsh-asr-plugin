#include "config_loader.h"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>

using json = nlohmann::json;

// 从文件加载配置
std::optional<RecordingConfig> ConfigLoader::loadFromFile(const std::string& filepath) {
    try {
        // 读取文件
        std::ifstream file(filepath);
        if (!file.is_open()) {
            setError("无法打开文件: " + filepath);
            std::cerr << "错误: " << lastError << std::endl;
            return std::nullopt;
        }

        // 解析 JSON
        json j;
        file >> j;
        file.close();

        // 解析为 RecordingConfig
        return parseJson(&j);

    } catch (const json::parse_error& e) {
        setError("JSON 解析错误: " + std::string(e.what()));
        std::cerr << "错误: " << lastError << std::endl;
        return std::nullopt;
    } catch (const std::exception& e) {
        setError("加载配置失败: " + std::string(e.what()));
        std::cerr << "错误: " << lastError << std::endl;
        return std::nullopt;
    }
}

// 从 JSON 字符串加载配置
std::optional<RecordingConfig> ConfigLoader::loadFromString(const std::string& jsonString) {
    try {
        // 解析 JSON
        json j = json::parse(jsonString);

        // 解析为 RecordingConfig
        return parseJson(&j);

    } catch (const json::parse_error& e) {
        setError("JSON 解析错误: " + std::string(e.what()));
        std::cerr << "错误: " << lastError << std::endl;
        return std::nullopt;
    } catch (const std::exception& e) {
        setError("解析配置失败: " + std::string(e.what()));
        std::cerr << "错误: " << lastError << std::endl;
        return std::nullopt;
    }
}

// 解析 JSON 对象为 RecordingConfig
std::optional<RecordingConfig> ConfigLoader::parseJson(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    RecordingConfig config;

    try {
        // 1. 解析 version
        if (j.contains("version")) {
            config.version = j["version"].get<std::string>();
        }

        // 2. 解析 sources（必需）
        if (!j.contains("sources")) {
            setError("缺少必需字段: sources");
            return std::nullopt;
        }
        auto sources = parseSources(&j["sources"]);
        if (!sources.has_value()) {
            return std::nullopt;
        }
        config.sources = std::move(sources.value());

        // 3. 解析 tap（可选，使用默认值）
        if (j.contains("tap")) {
            auto tapConfig = parseTapConfig(&j["tap"]);
            if (!tapConfig.has_value()) {
                return std::nullopt;
            }
            config.tap = std::move(tapConfig.value());
        }

        // 4. 解析 aggregateDevice（可选，使用默认值）
        if (j.contains("aggregateDevice")) {
            auto aggConfig = parseAggregateDeviceConfig(&j["aggregateDevice"]);
            if (!aggConfig.has_value()) {
                return std::nullopt;
            }
            config.aggregateDevice = std::move(aggConfig.value());
        }

        // 5. 解析 recorder（可选，使用默认值）
        if (j.contains("recorder")) {
            auto recConfig = parseRecorderConfig(&j["recorder"]);
            if (!recConfig.has_value()) {
                return std::nullopt;
            }
            config.recorder = std::move(recConfig.value());
        }

        // 6. 解析 runtime（可选，使用默认值）
        if (j.contains("runtime")) {
            auto runConfig = parseRuntimeConfig(&j["runtime"]);
            if (!runConfig.has_value()) {
                return std::nullopt;
            }
            config.runtime = std::move(runConfig.value());
        }

        // 7. 验证配置
        if (!config.isValid()) {
            setError("配置验证失败");
            return std::nullopt;
        }

        return config;

    } catch (const json::exception& e) {
        setError("JSON 字段解析错误: " + std::string(e.what()));
        std::cerr << "错误: " << lastError << std::endl;
        return std::nullopt;
    }
}

// 解析 AudioSource 列表
std::optional<std::vector<AudioSource>> ConfigLoader::parseSources(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    std::vector<AudioSource> sources;

    try {
        for (const auto& item : j) {
            AudioSource source;

            // 解析 type（必需）
            if (!item.contains("type")) {
                setError("sources 元素缺少必需字段: type");
                return std::nullopt;
            }

            std::string typeStr = item["type"].get<std::string>();
            if (typeStr == "process_tap") {
                source.type = AudioSourceType::ProcessTap;

                // ProcessTap 需要 pid
                if (!item.contains("pid")) {
                    setError("process_tap 类型的 source 缺少必需字段: pid");
                    return std::nullopt;
                }
                source.pid = item["pid"].get<pid_t>();

            } else if (typeStr == "microphone") {
                source.type = AudioSourceType::Microphone;

                // Microphone 可选 deviceUID
                if (item.contains("deviceUID")) {
                    source.deviceUID = item["deviceUID"].get<std::string>();
                } else {
                    source.deviceUID = "";  // 默认设备
                }

            } else {
                setError("不支持的 source 类型: " + typeStr);
                return std::nullopt;
            }

            sources.push_back(source);
        }

        if (sources.empty()) {
            setError("sources 列表不能为空");
            return std::nullopt;
        }

        return sources;

    } catch (const json::exception& e) {
        setError("解析 sources 失败: " + std::string(e.what()));
        return std::nullopt;
    }
}

// 解析 TapConfig
std::optional<TapConfig> ConfigLoader::parseTapConfig(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    TapConfig config;

    try {
        if (j.contains("name")) {
            config.name = j["name"].get<std::string>();
        }

        if (j.contains("isPrivate")) {
            config.isPrivate = j["isPrivate"].get<bool>();
        }

        if (j.contains("isProcessRestoreEnabled")) {
            config.isProcessRestoreEnabled = j["isProcessRestoreEnabled"].get<bool>();
        }

        if (j.contains("muteBehavior")) {
            std::string str = j["muteBehavior"].get<std::string>();
            config.muteBehavior = TapConfig::muteBehaviorFromString(str);
        }

        if (j.contains("mixdownMode")) {
            std::string str = j["mixdownMode"].get<std::string>();
            config.mixdownMode = TapConfig::mixdownModeFromString(str);
        }

        if (j.contains("isExclusive")) {
            config.isExclusive = j["isExclusive"].get<bool>();
        }

        if (j.contains("deviceUID")) {
            if (j["deviceUID"].is_null()) {
                config.deviceUID = std::nullopt;
            } else {
                config.deviceUID = j["deviceUID"].get<std::string>();
            }
        }

        if (j.contains("streamIndex")) {
            config.streamIndex = j["streamIndex"].get<UInt32>();
        }

        return config;

    } catch (const std::exception& e) {
        setError("解析 tap 配置失败: " + std::string(e.what()));
        return std::nullopt;
    }
}

// 解析 AggregateDeviceConfig
std::optional<AggregateDeviceConfig> ConfigLoader::parseAggregateDeviceConfig(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    AggregateDeviceConfig config;

    try {
        if (j.contains("name")) {
            config.name = j["name"].get<std::string>();
        }

        if (j.contains("isPrivate")) {
            config.isPrivate = j["isPrivate"].get<bool>();
        }

        if (j.contains("tapAutoStart")) {
            config.tapAutoStart = j["tapAutoStart"].get<bool>();
        }

        // V1.1 变更: autoStop 已移动到 runtime.autoStopOnProcessExit
        // 为了向后兼容,如果发现旧配置,输出警告但不影响加载
        if (j.contains("autoStop")) {
            std::cerr << "警告: aggregateDevice.autoStop 已废弃,请使用 runtime.autoStopOnProcessExit" << std::endl;
        }

        return config;

    } catch (const std::exception& e) {
        setError("解析 aggregateDevice 配置失败: " + std::string(e.what()));
        return std::nullopt;
    }
}

// 解析 RecorderConfig
std::optional<RecorderConfig> ConfigLoader::parseRecorderConfig(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    RecorderConfig config;

    try {
        if (j.contains("outputBasePath")) {
            config.outputBasePath = j["outputBasePath"].get<std::string>();
        }

        if (j.contains("separateStreams")) {
            config.separateStreams = j["separateStreams"].get<bool>();
        }

        if (j.contains("timestampInFilename")) {
            config.timestampInFilename = j["timestampInFilename"].get<bool>();
        }

        if (j.contains("fileNamePattern")) {
            config.fileNamePattern = j["fileNamePattern"].get<std::string>();
        }

        if (j.contains("modeLabel")) {
            config.modeLabel = j["modeLabel"].get<std::string>();
        }

        if (j.contains("outputFormat")) {
            std::string fmt = j["outputFormat"].get<std::string>();
            if (fmt == "wav") {
                config.outputFormat = OutputFileFormat::Wav;
            } else if (fmt == "caf") {
                config.outputFormat = OutputFileFormat::Caf;
            } else {
                setError("不支持的 outputFormat: " + fmt);
                return std::nullopt;
            }
        }

        if (j.contains("outputSampleRate")) {
            config.outputSampleRate = j["outputSampleRate"].get<double>();
        }

        if (j.contains("outputBitsPerSample")) {
            config.outputBitsPerSample = j["outputBitsPerSample"].get<int>();
        }

        if (j.contains("outputChannels")) {
            config.outputChannels = j["outputChannels"].get<int>();
        }

        if (j.contains("outputFloat")) {
            config.outputFloat = j["outputFloat"].get<bool>();
        }

        if (j.contains("chunkSizeSeconds")) {
            config.chunkSizeSeconds = j["chunkSizeSeconds"].get<double>();
        }

        if (j.contains("sourceLabel")) {
            config.sourceLabel = j["sourceLabel"].get<std::string>();
        }

        return config;

    } catch (const std::exception& e) {
        setError("解析 recorder 配置失败: " + std::string(e.what()));
        return std::nullopt;
    }
}

// 解析 RuntimeConfig
std::optional<RuntimeConfig> ConfigLoader::parseRuntimeConfig(const void* jsonPtr) {
    const json& j = *static_cast<const json*>(jsonPtr);

    RuntimeConfig config;

    try {
        if (j.contains("durationSeconds")) {
            config.durationSeconds = j["durationSeconds"].get<int>();
        }

        // V1.1 新增: autoStopOnProcessExit
        if (j.contains("autoStopOnProcessExit")) {
            config.autoStopOnProcessExit = j["autoStopOnProcessExit"].get<bool>();
        }

        if (j.contains("enableProcessBlacklist")) {
            config.enableProcessBlacklist = j["enableProcessBlacklist"].get<bool>();
        }

        return config;

    } catch (const std::exception& e) {
        setError("解析 runtime 配置失败: " + std::string(e.what()));
        return std::nullopt;
    }
}
