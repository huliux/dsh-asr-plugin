#ifndef AGGREGATE_DEVICE_CONFIG_H
#define AGGREGATE_DEVICE_CONFIG_H

#include <string>

/**
 * Aggregate Device 配置
 *
 * 对齐 Apple 官方示例 (CapturingSystemAudioWithCoreAudioTaps) 的 AggregateDevice 配置
 * 包含 CoreAudio API 配置 + 应用层逻辑
 *
 * 参考：
 * - AggregateDevice.swift: class AggregateDevice
 * - CoreAudio API: kAudioAggregateDevice* 系列属性键
 *
 * 字段分类：
 * 【CoreAudio API 配置】（通过 AudioObjectSetPropertyData 设置）
 * - name         → kAudioAggregateDeviceNameKey
 * - isPrivate    → kAudioAggregateDeviceIsPrivateKey
 * - tapAutoStart → kAudioAggregateDeviceTapAutoStartKey
 *
 * 【应用层逻辑】（不是 CoreAudio API，由应用程序实现）
 * - autoStop     → Apple 示例中的 @Published var autoStop (SwiftUI 状态)
 *                  作用：当所有被 Tap 的进程停止时，自动停止录制
 *                  注意：这不是 CoreAudio API 配置，没有对应的 kAudioAggregateDeviceTapAutoStopKey
 */
struct AggregateDeviceConfig {
    /**
     * 聚合设备名称
     * 对应：kAudioAggregateDeviceNameKey (CoreAudio API)
     * 默认值："Bitbook-Aggregate-Device"
     */
    std::string name = "Bitbook-Aggregate-Device";

    /**
     * 是否为私有设备（阻止其他应用使用此设备）
     * 对应：kAudioAggregateDeviceIsPrivateKey (CoreAudio API)
     * P1c 固定为 private，避免 capture child 强杀后留下全局聚合设备。
     */
    bool isPrivate = true;

    /**
     * 创建设备后是否自动启动 Tap
     * 对应：kAudioAggregateDeviceTapAutoStartKey (CoreAudio API)
     * 默认值：false
     *
     * 说明：
     * - true: 设备创建后立即开始捕获音频（适合实时监听场景）
     * - false: 需要手动启动 Tap（适合需要用户确认后才开始录制的场景）
     */
    bool tapAutoStart = false;

    // 验证配置有效性
    bool isValid() const;

    // 打印配置（用于调试）
    void print() const;
};

#endif // AGGREGATE_DEVICE_CONFIG_H
