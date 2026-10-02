#include "runtime_config.h"
#include <iostream>

// 验证配置有效性
bool RuntimeConfig::isValid() const {
    // 1. 检查 durationSeconds 非负
    if (durationSeconds < 0) {
        std::cerr << "RuntimeConfig 验证失败: durationSeconds 不能为负数 (当前: "
                  << durationSeconds << ")" << std::endl;
        return false;
    }

    // 2. 检查 durationSeconds 不超过 24 小时（86400 秒）
    const int MAX_DURATION_SECONDS = 86400; // 24 小时
    if (durationSeconds > MAX_DURATION_SECONDS) {
        std::cerr << "RuntimeConfig 验证失败: durationSeconds 不能超过 "
                  << MAX_DURATION_SECONDS << " 秒 (24 小时)，当前: "
                  << durationSeconds << " 秒" << std::endl;
        return false;
    }

    return true;
}

// 打印配置（用于调试）
void RuntimeConfig::print() const {
    std::cout << "=== RuntimeConfig ===" << std::endl;

    if (isUnlimitedDuration()) {
        std::cout << "  durationSeconds: 0 (无限录制模式)" << std::endl;
        std::cout << "  停止方式: 手动 Ctrl+C 或配合 autoStop=true 自动停止" << std::endl;
    } else {
        std::cout << "  durationSeconds: " << durationSeconds << " 秒" << std::endl;
        std::cout << "  停止方式: " << durationSeconds << " 秒后自动停止" << std::endl;
    }

    std::cout << "  autoStopOnProcessExit: " << (autoStopOnProcessExit ? "true" : "false")
              << std::endl;
    std::cout << "  enableProcessBlacklist: " << (enableProcessBlacklist ? "true" : "false")
              << std::endl;

    std::cout << "=====================" << std::endl;
}
