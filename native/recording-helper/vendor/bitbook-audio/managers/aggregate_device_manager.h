#ifndef AGGREGATE_DEVICE_MANAGER_H
#define AGGREGATE_DEVICE_MANAGER_H

#include "config/aggregate_device_config.h"
#include "business/property_observer.h"
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <string>
#include <vector>
#include <set>

/**
 * Aggregate Device 管理器
 *
 * 职责：管理 Aggregate Device 的创建、配置和生命周期
 *
 * 对应 Apple 官方示例：
 * - AggregateDevice.swift: class AggregateDevice
 * - AggregateDeviceView.swift: addSubTap() 方法
 *
 * 核心功能：
 * - 创建空的 Aggregate Device（不包含 TapList 和 SubDeviceList）
 * - 动态添加 Process Tap（使用 AudioObjectSetPropertyData）
 * - 动态添加麦克风设备（使用 SubDeviceList）
 * - 设置 CoreAudio 属性（isPrivate, tapAutoStart）
 * - RAII 自动资源清理
 *
 * 实现要点：
 * 1. 创建设备时不设置 TapList 和 SubDeviceList（Apple 推荐方式）
 * 2. 使用 AudioObjectSetPropertyData 动态添加 Tap（对应 UI 勾选操作）
 * 3. 添加设备后等待 200ms 让系统初始化所有流
 * 4. 销毁时使用 AudioHardwareDestroyAggregateDevice
 *
 * 使用示例：
 * ```cpp
 * AggregateDeviceConfig config;
 * config.name = "My Device";
 * config.isPrivate = true;
 * config.tapAutoStart = true;
 *
 * AggregateDeviceManager manager(config);
 * if (manager.createDevice()) {
 *     // 添加 Tap（来自 ProcessTapManager）
 *     if (manager.addTap(tapUUID)) {
 *         // 可选：添加麦克风
 *         manager.addMicrophone("BuiltInMicrophoneDevice");
 *
 *         AudioObjectID deviceID = manager.getDeviceID();
 *         // 使用 deviceID 进行录制...
 *     }
 * }
 * // 析构时自动清理
 * ```
 */
class AggregateDeviceManager {
public:
    /**
     * 构造函数
     *
     * @param config Aggregate Device 配置
     */
    AggregateDeviceManager(const AggregateDeviceConfig& config);

    /**
     * 析构函数（自动清理资源）
     *
     * 调用 destroyDevice() 清理 Aggregate Device
     */
    ~AggregateDeviceManager();

    // 禁止拷贝和赋值（资源唯一性）
    AggregateDeviceManager(const AggregateDeviceManager&) = delete;
    AggregateDeviceManager& operator=(const AggregateDeviceManager&) = delete;

    /**
     * 创建 Aggregate Device
     *
     * 步骤：
     * 1. 生成唯一设备 UID
     * 2. 创建配置字典（name, isPrivate, tapAutoStart）
     * 3. 可选：添加 SubDeviceList（麦克风列表，如果 microphoneUIDs 不为空）
     * 4. 调用 AudioHardwareCreateAggregateDevice
     * 5. 不设置 TapList（后续动态添加）
     *
     * @param microphoneUIDs 麦克风设备 UID 列表（可选，为空则不添加麦克风）
     * @return 成功返回 true，失败返回 false（调用 getLastError() 查看详情）
     */
    bool createDevice(const std::vector<std::string>& microphoneUIDs = {});

    /**
     * 动态添加 Process Tap
     *
     * 对应 Apple 示例的 addSubTap() 方法
     *
     * 步骤：
     * 1. 读取当前 TapList
     * 2. 将新的 Tap UUID 转换为 CFStringRef
     * 3. 使用 AudioObjectSetPropertyData 设置 TapList
     * 4. 等待 200ms 让系统初始化流
     *
     * @param tapUUID Process Tap 的 UUID（来自 ProcessTapManager）
     * @return 成功返回 true，失败返回 false
     */
    bool addTap(CFUUIDRef tapUUID);

    /**
     * 动态添加麦克风设备
     *
     * 对应 Apple 示例的 addSubDevice() 方法
     *
     * 步骤：
     * 1. 读取当前 FullSubDeviceList
     * 2. 添加新的设备 UID
     * 3. 使用 AudioObjectSetPropertyData 设置 FullSubDeviceList
     * 4. 等待系统初始化流
     *
     * @param deviceUID 麦克风设备的 UID
     * @return 成功返回 true，失败返回 false
     */
    bool addMicrophone(const std::string& deviceUID);


    // ==================== 属性监听功能（Phase 3 新增）====================

    /**
     * 设置属性监听（对标 Apple 官方示例）
     *
     * 监听以下 3 个属性（与官方示例对齐）：
     * - kAudioAggregateDevicePropertyFullSubDeviceList: 设备列表变化
     * - kAudioAggregateDevicePropertyTapList: Tap 列表变化
     * - kAudioAggregateDevicePropertyComposition: 设备组成配置变化
     *
     * 当属性变化时，所有注册的 PropertyObserver 会收到回调。
     *
     * @return 成功返回 true，失败返回 false
     */
    bool setupPropertyListeners();

    /**
     * 移除属性监听
     *
     * 移除之前通过 setupPropertyListeners() 设置的属性监听。
     * 在 destroyDevice() 时自动调用。
     */
    void removePropertyListeners();

    /**
     * 注册属性观察者
     *
     * @param observer 观察者指针（调用方负责生命周期管理）
     */
    void addPropertyObserver(bitbook::business::PropertyObserver* observer);

    /**
     * 移除属性观察者
     *
     * @param observer 要移除的观察者指针
     */
    void removePropertyObserver(bitbook::business::PropertyObserver* observer);

    /**
     * 销毁 Aggregate Device
     *
     * 调用 AudioHardwareDestroyAggregateDevice 销毁设备
     * 此方法是幂等的（多次调用安全）
     */
    void destroyDevice();

    /**
     * 获取 Aggregate Device ID（用于录制）
     *
     * @return 设备 AudioObjectID，如果未创建则返回 kAudioObjectUnknown
     */
    AudioObjectID getDeviceID() const { return deviceID_; }

    /**
     * 获取最后一次操作的错误信息
     *
     * @return 错误信息字符串
     */
    std::string getLastError() const { return lastError_; }

    /**
     * 检查设备是否已创建
     *
     * @return 已创建返回 true，否则返回 false
     */
    bool isCreated() const { return deviceID_ != kAudioObjectUnknown; }

    /**
     * 获取设备名称
     *
     * @return 设备名称
     */
    std::string getName() const { return config_.name; }

    // ==================== 查询方法（Phase 2 新增）====================

    /**
     * 获取子设备 UID 列表
     *
     * 查询 kAudioAggregateDevicePropertyFullSubDeviceList 属性。
     *
     * @return 设备 UID 列表，如果未创建或查询失败返回空列表
     */
    std::vector<std::string> getSubDeviceList() const;

    /**
     * 获取子 Tap UID 列表
     *
     * 查询 kAudioAggregateDevicePropertyTapList 属性。
     *
     * @return Tap UID 列表，如果未创建或查询失败返回空列表
     */
    std::vector<std::string> getTapList() const;

    /**
     * 获取 autoStop 配置
     *
     * 查询 kAudioAggregateDevicePropertyComposition 中的 autoStop 字段。
     *
     * @return autoStop 值
     */
    bool getAutoStop() const;

    /**
     * 获取 isPrivate 配置
     *
     * 查询设备的私有属性。
     *
     * @return isPrivate 值
     */
    bool getIsPrivate() const;

    /**
     * 获取 tapAutoStart 配置
     *
     * 查询 kAudioAggregateDevicePropertyComposition 中的 tapAutoStart 字段。
     *
     * @return tapAutoStart 值
     */
    bool getTapAutoStart() const;

    /**
     * 获取设备 UID
     *
     * @return 设备 UID 字符串
     */
    std::string getDeviceUID() const {
        return deviceUID_;
    }

private:
    AggregateDeviceConfig config_;  // Aggregate Device 配置
    AudioObjectID deviceID_;         // 设备 AudioObjectID（kAudioObjectUnknown 表示未创建）
    std::string deviceUID_;          // 设备 UID（用于销毁）
    std::string lastError_;          // 最后一次错误信息

    // 属性监听相关（Phase 3）
    std::set<bitbook::business::PropertyObserver*> observers_;  // 观察者集合
    bool listenersSetup_;            // 标记是否已设置监听

    /**
     * 设置错误信息
     *
     * @param error 错误信息
     */
    void setError(const std::string& error) {
        lastError_ = error;
    }

    /**
     * 等待系统初始化（200ms）
     *
     * 在添加 Tap 或麦克风后调用，让 CoreAudio 初始化所有流
     */
    void waitForSystemInitialization() const;

    /**
     * 通知所有观察者（属性变化时调用）
     *
     * @param address 属性地址
     */
    void notifyObservers(const AudioObjectPropertyAddress& address);

    /**
     * CoreAudio 属性监听回调（静态方法）
     *
     * @param inObjectID 设备 AudioObjectID
     * @param inNumberAddresses 属性地址数量
     * @param inAddresses 属性地址数组
     * @param inClientData 用户数据（AggregateDeviceManager* 指针）
     * @return OSStatus
     */
    static OSStatus propertyListenerProc(AudioObjectID inObjectID,
                                        UInt32 inNumberAddresses,
                                        const AudioObjectPropertyAddress inAddresses[],
                                        void* inClientData);
};

#endif // AGGREGATE_DEVICE_MANAGER_H
