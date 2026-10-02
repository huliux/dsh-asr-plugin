#include "config_types.h"
#include <iostream>

// =============== AudioSource ===============

bool AudioSource::isValid() const {
    if (type == AudioSourceType::ProcessTap) {
        // ProcessTap 的 PID 在配置加载阶段允许为 0（占位符）
        // 这表示 PID 需要在运行时通过命令行参数提供
        // 真正的 PID 验证应该在启动录制前进行
        if (pid < 0) {
            std::cerr << "AudioSource 验证失败: ProcessTap 的 pid 不能为负数 (当前: "
                      << pid << ")" << std::endl;
            return false;
        }
        // pid == 0 是合法的占位符，表示"需要用户提供"
    }
    // Microphone 的 deviceUID 可以为空（表示使用默认设备）

    return true;
}

void AudioSource::print() const {
    std::cout << "  AudioSource:" << std::endl;
    std::cout << "    type: " << (type == AudioSourceType::ProcessTap ? "ProcessTap" : "Microphone")
              << std::endl;

    if (type == AudioSourceType::ProcessTap) {
        std::cout << "    pid: " << pid << std::endl;
    } else {
        std::cout << "    deviceUID: " << (deviceUID.empty() ? "(default device)" : deviceUID)
                  << std::endl;
    }
}

// =============== RecordingConfig ===============

bool RecordingConfig::isValid() const {
    // 1. 检查版本
    if (version != "1.0" && version != "1.1") {
        std::cerr << "RecordingConfig 验证失败: 不支持的版本 '" << version
                  << "'，当前支持 '1.0' 和 '1.1'" << std::endl;
        return false;
    }

    // 2. 检查至少有一个音频源
    if (sources.empty()) {
        std::cerr << "RecordingConfig 验证失败: 必须至少指定一个音频源 (sources)" << std::endl;
        return false;
    }

    // 3. 验证所有音频源
    for (size_t i = 0; i < sources.size(); ++i) {
        if (!sources[i].isValid()) {
            std::cerr << "RecordingConfig 验证失败: 音频源 [" << i << "] 无效" << std::endl;
            return false;
        }
    }

    // 4. 验证各个配置模块
    if (!tap.isValid()) {
        std::cerr << "RecordingConfig 验证失败: tap 配置无效" << std::endl;
        return false;
    }

    if (!aggregateDevice.isValid()) {
        std::cerr << "RecordingConfig 验证失败: aggregateDevice 配置无效" << std::endl;
        return false;
    }

    if (!recorder.isValid()) {
        std::cerr << "RecordingConfig 验证失败: recorder 配置无效" << std::endl;
        return false;
    }

    if (!runtime.isValid()) {
        std::cerr << "RecordingConfig 验证失败: runtime 配置无效" << std::endl;
        return false;
    }

    // 5. 如果包含 ProcessTap，确保 tap 配置合理
    if (hasProcessTap()) {
        // ProcessTap 需要有效的 tap 配置
        // (已在 tap.isValid() 中验证)
    }

    return true;
}

void RecordingConfig::print() const {
    std::cout << "\n========== RecordingConfig ==========" << std::endl;
    std::cout << "version: " << version << std::endl;

    std::cout << "\nsources (" << sources.size() << "):" << std::endl;
    for (const auto& source : sources) {
        source.print();
    }

    std::cout << std::endl;
    tap.print();

    std::cout << std::endl;
    aggregateDevice.print();

    std::cout << std::endl;
    recorder.print();

    std::cout << std::endl;
    runtime.print();

    std::cout << "====================================\n" << std::endl;
}

bool RecordingConfig::hasProcessTap() const {
    for (const auto& source : sources) {
        if (source.type == AudioSourceType::ProcessTap) {
            return true;
        }
    }
    return false;
}

bool RecordingConfig::hasMicrophone() const {
    for (const auto& source : sources) {
        if (source.type == AudioSourceType::Microphone) {
            return true;
        }
    }
    return false;
}

pid_t RecordingConfig::getProcessTapPid() const {
    for (const auto& source : sources) {
        if (source.type == AudioSourceType::ProcessTap) {
            return source.pid;
        }
    }
    return 0;
}

std::string RecordingConfig::getMicrophoneDeviceUID() const {
    for (const auto& source : sources) {
        if (source.type == AudioSourceType::Microphone) {
            return source.deviceUID;
        }
    }
    return "";
}
