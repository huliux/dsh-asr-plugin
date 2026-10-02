#include "tap_config.h"
#include <iostream>
#include <stdexcept>

// 从 JSON 字符串转换为 MuteBehavior 枚举
TapConfig::MuteBehavior TapConfig::muteBehaviorFromString(const std::string& str) {
    if (str == "unmuted") return MuteBehavior::Unmuted;
    if (str == "muted") return MuteBehavior::Muted;
    if (str == "muted_when_tapped") return MuteBehavior::MutedWhenTapped;

    throw std::invalid_argument("Invalid muteBehavior value: " + str +
                                ". Expected: unmuted, muted, or muted_when_tapped");
}

// 从 JSON 字符串转换为 MixdownMode 枚举
TapConfig::MixdownMode TapConfig::mixdownModeFromString(const std::string& str) {
    if (str == "mono") return MixdownMode::Mono;
    if (str == "stereo") return MixdownMode::Stereo;
    if (str == "device_format") return MixdownMode::DeviceFormat;

    throw std::invalid_argument("Invalid mixdownMode value: " + str +
                                ". Expected: mono, stereo, or device_format");
}

// 从 MuteBehavior 枚举转换为 JSON 字符串
std::string TapConfig::muteBehaviorToString(MuteBehavior behavior) {
    switch (behavior) {
        case MuteBehavior::Unmuted: return "unmuted";
        case MuteBehavior::Muted: return "muted";
        case MuteBehavior::MutedWhenTapped: return "muted_when_tapped";
        default:
            throw std::invalid_argument("Invalid MuteBehavior enum value: " +
                                        std::to_string(static_cast<int>(behavior)));
    }
}

// 从 MixdownMode 枚举转换为 JSON 字符串
std::string TapConfig::mixdownModeToString(MixdownMode mode) {
    switch (mode) {
        case MixdownMode::Mono: return "mono";
        case MixdownMode::Stereo: return "stereo";
        case MixdownMode::DeviceFormat: return "device_format";
        default:
            throw std::invalid_argument("Invalid MixdownMode enum value: " +
                                        std::to_string(static_cast<int>(mode)));
    }
}

// 验证配置有效性
bool TapConfig::isValid() const {
    // 1. 检查 name 不为空
    if (name.empty()) {
        std::cerr << "TapConfig 验证失败: name 不能为空" << std::endl;
        return false;
    }

    // 2. 检查 name 长度不超过 255 字符（CoreAudio 限制）
    if (name.length() > 255) {
        std::cerr << "TapConfig 验证失败: name 长度不能超过 255 字符 (当前: "
                  << name.length() << ")" << std::endl;
        return false;
    }

    // 3. 如果 mixdownMode 是 DeviceFormat，必须提供 deviceUID
    if (mixdownMode == MixdownMode::DeviceFormat && !deviceUID.has_value()) {
        std::cerr << "TapConfig 验证失败: mixdownMode=device_format 时必须提供 deviceUID"
                  << std::endl;
        return false;
    }

    // 4. 如果 mixdownMode 不是 DeviceFormat，deviceUID 应该为空
    if (mixdownMode != MixdownMode::DeviceFormat && deviceUID.has_value()) {
        std::cerr << "TapConfig 警告: mixdownMode 不是 device_format，但提供了 deviceUID (将被忽略)"
                  << std::endl;
        // 这是警告，不影响有效性
    }

    return true;
}

// 打印配置（用于调试）
void TapConfig::print() const {
    std::cout << "=== TapConfig ===" << std::endl;
    std::cout << "  name: " << name << std::endl;

    // 打印进程列表
    std::cout << "  processes: [";
    if (processes.empty()) {
        std::cout << "空集合";
    } else {
        bool first = true;
        for (AudioObjectID processID : processes) {
            if (!first) std::cout << ", ";
            std::cout << processID;
            first = false;
        }
    }
    std::cout << "] (共 " << processes.size() << " 个进程)" << std::endl;

    std::cout << "  isPrivate: " << (isPrivate ? "true" : "false") << std::endl;
    std::cout << "  isProcessRestoreEnabled: " << (isProcessRestoreEnabled ? "true" : "false") << std::endl;
    std::cout << "  muteBehavior: " << muteBehaviorToString(muteBehavior) << std::endl;
    std::cout << "  mixdownMode: " << mixdownModeToString(mixdownMode) << std::endl;
    std::cout << "  isExclusive: " << (isExclusive ? "true" : "false") << std::endl;

    if (deviceUID.has_value()) {
        std::cout << "  deviceUID: " << deviceUID.value() << std::endl;
    } else {
        std::cout << "  deviceUID: null" << std::endl;
    }

    std::cout << "  streamIndex: " << streamIndex << std::endl;
    std::cout << "=================" << std::endl;
}
