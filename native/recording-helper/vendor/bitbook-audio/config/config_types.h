#ifndef CONFIG_TYPES_H
#define CONFIG_TYPES_H

#include "tap_config.h"
#include "aggregate_device_config.h"
#include "recorder_config.h"
#include "runtime_config.h"
#include <vector>
#include <string>
#include <CoreAudio/CoreAudio.h>

/**
 * 音频源类型
 */
enum class AudioSourceType {
    ProcessTap,    // Process Tap 音频捕获
    Microphone     // 麦克风输入
};

/**
 * 音频源配置
 *
 * 描述单个音频输入源（Process Tap 或 Microphone）
 */
struct AudioSource {
    AudioSourceType type;

    // ProcessTap 特定字段
    pid_t pid = 0;  // 进程 ID（type=ProcessTap 时必需）

    // Microphone 特定字段
    std::string deviceUID;  // 设备 UID（type=Microphone 时可选，空字符串表示使用默认麦克风）

    // 验证有效性
    bool isValid() const;

    // 打印配置
    void print() const;
};

/**
 * 完整的录制配置
 *
 * 整合所有配置层级，对应 JSON 配置文件的完整结构
 *
 * JSON 结构：
 * {
 *   "version": "1.0",
 *   "sources": [...],                    // AudioSource[]
 *   "tap": {...},                        // TapConfig
 *   "aggregateDevice": {...},            // AggregateDeviceConfig
 *   "recorder": {...},                   // RecorderConfig
 *   "runtime": {...}                     // RuntimeConfig
 * }
 */
struct RecordingConfig {
    /**
     * 配置文件版本
     * 当前支持："1.0"
     */
    std::string version = "1.0";

    /**
     * 音频源列表
     * 至少包含一个音频源（ProcessTap 或 Microphone）
     */
    std::vector<AudioSource> sources;

    /**
     * Process Tap 配置（仅当 sources 包含 ProcessTap 时使用）
     */
    TapConfig tap;

    /**
     * Aggregate Device 配置
     */
    AggregateDeviceConfig aggregateDevice;

    /**
     * 录制器配置
     */
    RecorderConfig recorder;

    /**
     * 运行时配置
     */
    RuntimeConfig runtime;

    // 验证配置有效性
    bool isValid() const;

    // 打印配置（用于调试）
    void print() const;

    /**
     * 检查是否包含 ProcessTap 音频源
     */
    bool hasProcessTap() const;

    /**
     * 检查是否包含 Microphone 音频源
     */
    bool hasMicrophone() const;

    /**
     * 获取第一个 ProcessTap 的 PID
     * @return PID，如果没有 ProcessTap 则返回 0
     */
    pid_t getProcessTapPid() const;

    /**
     * 获取第一个 Microphone 的 deviceUID
     * @return deviceUID，如果没有 Microphone 则返回空字符串
     */
    std::string getMicrophoneDeviceUID() const;
};

#endif // CONFIG_TYPES_H
