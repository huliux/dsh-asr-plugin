#include "aggregate_device_config.h"
#include <iostream>

// 验证配置有效性
bool AggregateDeviceConfig::isValid() const {
    // 1. 检查 name 不为空
    if (name.empty()) {
        std::cerr << "AggregateDeviceConfig 验证失败: name 不能为空" << std::endl;
        return false;
    }

    // 2. 检查 name 长度不超过 255 字符（CoreAudio 限制）
    if (name.length() > 255) {
        std::cerr << "AggregateDeviceConfig 验证失败: name 长度不能超过 255 字符 (当前: "
                  << name.length() << ")" << std::endl;
        return false;
    }

    // 3. 所有配置都是合理的布尔值，无需额外验证

    return true;
}

// 打印配置（用于调试）
void AggregateDeviceConfig::print() const {
    std::cout << "=== AggregateDeviceConfig ===" << std::endl;
    std::cout << "  name: " << name << std::endl;
    std::cout << "  isPrivate: " << (isPrivate ? "true" : "false") << std::endl;
    std::cout << "  tapAutoStart: " << (tapAutoStart ? "true" : "false")
              << " (CoreAudio API)" << std::endl;
    std::cout << "=============================" << std::endl;
}
