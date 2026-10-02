#ifndef SYSTEM_RESOURCE_MANAGER_H
#define SYSTEM_RESOURCE_MANAGER_H

#include "business/audio_process.h"
#include "business/audio_tap.h"
#include <CoreAudio/CoreAudio.h>
#include <vector>
#include <memory>
#include <string>

namespace bitbook {

/**
 * @brief 系统资源管理器
 *
 * 负责枚举和管理系统级的音频资源（进程、Tap、设备）。
 * 对标 Apple 官方示例的 Model 类的资源管理职责。
 *
 * 核心功能:
 * - 枚举系统所有音频进程（kAudioHardwarePropertyProcessObjectList）
 * - 枚举系统所有 Tap（kAudioHardwarePropertyTapList）
 * - 枚举系统所有音频设备
 * - 为 CLI 命令提供数据支持
 *
 * 设计说明:
 * - 使用静态方法（无需单例，CLI 场景下按需调用）
 * - 返回 shared_ptr（多处使用同一资源）
 * - 可选：支持属性监听（为未来 GUI 准备）
 *
 * 与 Apple 官方对齐:
 * - 对应 Model.swift 的 loadProcessList(), loadTapList() 等方法
 * - 使用相同的 CoreAudio 查询 API
 * - 返回业务对象列表
 *
 * Phase 2 实现范围:
 * - 系统进程枚举
 * - 系统 Tap 枚举
 * - 系统设备枚举
 * - CLI 命令支持（--list-processes, --list-taps, --list-devices）
 *
 * 使用示例:
 * @code
 * // 枚举系统进程
 * auto processes = SystemResourceManager::loadProcessList();
 * for (const auto& process : processes) {
 *     std::cout << process->getProcessName() << std::endl;
 * }
 *
 * // 枚举系统 Tap
 * auto taps = SystemResourceManager::loadTapList();
 * for (const auto& tap : taps) {
 *     std::cout << tap->getUID() << std::endl;
 * }
 *
 * // 枚举系统设备
 * auto devices = SystemResourceManager::loadDeviceList();
 * for (const auto& device : devices) {
 *     std::cout << device.name << std::endl;
 * }
 * @endcode
 */
class SystemResourceManager {
public:
    /**
     * @brief 设备信息结构体
     */
    struct DeviceInfo {
        std::string uid;        // 设备 UID
        std::string name;       // 设备名称
        bool hasInput;          // 是否有输入能力
        bool hasOutput;         // 是否有输出能力
        AudioObjectID deviceID; // CoreAudio 设备 ID
    };

    /**
     * @brief 加载系统所有音频进程列表
     *
     * 查询 kAudioHardwarePropertyProcessObjectList，
     * 为每个 ProcessID 创建 AudioProcess 对象。
     *
     * @return AudioProcess 对象列表（shared_ptr）
     *
     * @note 返回的进程列表按 PID 排序
     * @note 过滤掉无效或无法访问的进程
     */
    static std::vector<std::shared_ptr<business::AudioProcess>> loadProcessList();

    /**
     * @brief 加载系统所有 Tap 列表
     *
     * 查询 kAudioHardwarePropertyTapList，
     * 为每个 TapID 创建 AudioTap 对象。
     *
     * @return AudioTap 对象列表（shared_ptr）
     *
     * @note 如果系统中没有 Tap，返回空列表
     */
    static std::vector<std::shared_ptr<business::AudioTap>> loadTapList();

    /**
     * @brief 加载系统所有音频设备列表
     *
     * 查询 kAudioHardwarePropertyDevices，
     * 为每个设备查询 UID、名称、输入/输出能力。
     *
     * @return 设备信息列表
     *
     * @note 包含所有类型的音频设备（输入、输出、聚合设备等）
     */
    static std::vector<DeviceInfo> loadDeviceList();

    /**
     * @brief 根据 PID 查找 AudioProcess
     *
     * @param pid 进程 PID
     * @return AudioProcess 对象，如果未找到返回 nullptr
     */
    static std::shared_ptr<business::AudioProcess> findProcessByPID(pid_t pid);

    /**
     * @brief 根据 UID 查找 AudioTap
     *
     * @param uid Tap UID
     * @return AudioTap 对象，如果未找到返回 nullptr
     */
    static std::shared_ptr<business::AudioTap> findTapByUID(const std::string& uid);

    /**
     * @brief 根据 UID 查找设备信息
     *
     * @param uid 设备 UID
     * @return 设备信息，如果未找到返回空 DeviceInfo
     */
    static DeviceInfo findDeviceByUID(const std::string& uid);

private:
    // 静态工具类，禁止实例化
    SystemResourceManager() = delete;
    ~SystemResourceManager() = delete;
    SystemResourceManager(const SystemResourceManager&) = delete;
    SystemResourceManager& operator=(const SystemResourceManager&) = delete;

    /**
     * @brief 查询设备的输入/输出能力
     *
     * @param deviceID 设备 AudioObjectID
     * @param hasInput 输出参数：是否有输入能力
     * @param hasOutput 输出参数：是否有输出能力
     */
    static void queryDeviceCapabilities(AudioObjectID deviceID, bool& hasInput, bool& hasOutput);

    /**
     * @brief 获取设备名称
     *
     * @param deviceID 设备 AudioObjectID
     * @return 设备名称
     */
    static std::string getDeviceName(AudioObjectID deviceID);

    /**
     * @brief 获取设备 UID
     *
     * @param deviceID 设备 AudioObjectID
     * @return 设备 UID
     */
    static std::string getDeviceUID(AudioObjectID deviceID);
};

} // namespace bitbook

#endif // SYSTEM_RESOURCE_MANAGER_H
