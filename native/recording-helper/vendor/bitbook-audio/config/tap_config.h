#ifndef TAP_CONFIG_H
#define TAP_CONFIG_H

#include <string>
#include <optional>
#include <set>
#include <CoreAudio/CoreAudio.h>

/**
 * Process Tap 配置
 *
 * 100% 对齐 Apple 官方示例 (CapturingSystemAudioWithCoreAudioTaps) 的 TapConfig 结构
 * 以及底层的 CATapDescription C 结构体
 *
 * 参考：
 * - AudioTap.swift: struct TapConfig (9 个字段)
 * - CoreAudio API: CATapDescription (10 个字段，processes 是运行时动态添加)
 *
 * 字段映射：
 * - name              → CATapDescription.name
 * - isPrivate         → CATapDescription.isPrivate
 * - isProcessRestoreEnabled → CATapDescription.isProcessRestoreEnabled
 * - muteBehavior      → CATapDescription.muteBehavior (enum: 0=unmuted, 1=muted, 2=muted_when_tapped)
 * - mixdownMode       → CATapDescription.isMixdown + isMono (enum: 0=mono, 1=stereo, 2=device_format)
 * - isExclusive       → CATapDescription.isExclusive
 * - deviceUID         → CATapDescription.deviceUID (仅在 mixdownMode=device_format 时有效)
 * - streamIndex       → CATapDescription.stream (仅在 mixdownMode=device_format 时有效)
 */
struct TapConfig {
    /**
     * Tap 标识名称
     * 对应：CATapDescription.name
     * 默认值："Sample audio tap"
     */
    std::string name = "Sample audio tap";

    /**
     * 进程列表（Process Tap 监听的进程 ID 集合）
     * 对应：CATapDescription.processes (NSArray<NSNumber*>)
     * 默认值：空集合
     *
     * 说明：
     * - 这是 Apple 官方 TapConfig 的第 2 个字段（name 之后）
     * - 参考：AudioTap.swift - struct TapConfig { var processes: Set<AudioObjectID> }
     * - 空集合表示未指定进程（由外部决定如何处理）
     * - 非空集合表示要监听的具体进程 ID 列表
     *
     * 使用场景：
     * - 全局模式：包含所有音频进程的 ID
     * - 指定模式：仅包含特定进程的 ID（例如单个应用）
     * - 动态切换：通过 AudioTap::updateConfig() 更新此字段实现模式切换
     *
     * 注意：
     * - CoreAudio 使用 CFArrayRef (NSArray) 存储，我们使用 std::set 方便去重和查找
     * - AudioTap::getConfig() 将 CFArray 转换为 std::set
     * - AudioTap::updateConfig() 将 std::set 转换为 CFArray
     */
    std::set<AudioObjectID> processes;

    /**
     * 是否为私有 Tap（阻止其他应用访问）
     * 对应：CATapDescription.isPrivate
     * 默认值：false
     */
    bool isPrivate = false;

    /**
     * 销毁 Tap 时是否恢复进程音频输出
     * 对应：CATapDescription.isProcessRestoreEnabled
     * 默认值：true
     */
    bool isProcessRestoreEnabled = true;

    /**
     * 静音行为
     * 对应：CATapDescription.muteBehavior
     * 枚举值：
     * - "unmuted" (0): 不静音，进程音频正常输出
     * - "muted" (1): 完全静音，进程音频不输出
     * - "muted_when_tapped" (2): 被 Tap 时静音（录制时静音输出）
     */
    enum class MuteBehavior {
        Unmuted = 0,           // 不静音
        Muted = 1,             // 完全静音
        MutedWhenTapped = 2    // 被 Tap 时静音
    };
    MuteBehavior muteBehavior = MuteBehavior::Unmuted;

    /**
     * 混音模式
     * 对应：CATapDescription.isMixdown + isMono
     * 枚举值：
     * - "mono" (0): 单声道混音
     * - "stereo" (1): 立体声混音
     * - "device_format" (2): 使用目标设备格式（需要配合 deviceUID 和 streamIndex）
     */
    enum class MixdownMode {
        Mono = 0,          // 单声道
        Stereo = 1,        // 立体声
        DeviceFormat = 2   // 设备格式
    };
    MixdownMode mixdownMode = MixdownMode::Stereo;

    /**
     * 是否为独占模式（阻止其他 Tap 访问同一进程）
     * 对应：CATapDescription.isExclusive
     * 默认值：false
     */
    bool isExclusive = false;

    /**
     * 目标设备 UID（仅在 mixdownMode=DeviceFormat 时有效）
     * 对应：CATapDescription.deviceUID
     * 默认值：nullptr (使用 std::optional 表示可选)
     */
    std::optional<std::string> deviceUID = std::nullopt;

    /**
     * 流索引（仅在 mixdownMode=DeviceFormat 时有效）
     * 对应：CATapDescription.stream
     * 默认值：0
     */
    UInt32 streamIndex = 0;

    // 工具方法：从 JSON 字符串转换为枚举
    static MuteBehavior muteBehaviorFromString(const std::string& str);
    static MixdownMode mixdownModeFromString(const std::string& str);

    // 工具方法：从枚举转换为 JSON 字符串
    static std::string muteBehaviorToString(MuteBehavior behavior);
    static std::string mixdownModeToString(MixdownMode mode);

    // 验证配置有效性
    bool isValid() const;

    // 打印配置（用于调试）
    void print() const;
};

#endif // TAP_CONFIG_H
