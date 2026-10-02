#ifndef AUDIO_TAP_H
#define AUDIO_TAP_H

#include "property_observer.h"
#include "config/tap_config.h"
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <string>
#include <vector>

namespace bitbook::business {

/**
 * @brief AudioTap - Process Tap 业务对象
 *
 * 封装 Process Tap 的信息、配置和状态，对标 Apple 官方示例的 AudioTap.swift。
 *
 * 核心功能:
 * - 封装 Tap 基本信息（UUID, 格式）
 * - 查询和更新 Tap 配置（TapConfig）
 * - 监听 Tap 配置变化（kAudioTapPropertyDescription）
 * - 支持观察者模式
 *
 * 与 Apple 官方对齐:
 * - 对应 AudioTap.swift 类
 * - 使用 kAudioTapPropertyDescription 查询配置
 * - 支持运行时配置修改
 *
 * Phase 2 实现范围:
 * - Tap 信息查询（UUID, 格式）
 * - 配置查询和更新（TapConfig）
 * - 可选：配置变化监听（为未来 GUI 准备）
 *
 * 使用示例:
 * @code
 * // 通过 UUID 创建 AudioTap 对象
 * auto tap = std::make_unique<AudioTap>(tapUUID);
 *
 * // 查询 Tap 信息
 * std::string uid = tap->getUID();
 * TapConfig config = tap->getConfig();
 *
 * // 更新配置
 * TapConfig newConfig = config;
 * newConfig.muteBehavior = TapConfig::MuteBehavior::Muted;
 * tap->updateConfig(newConfig);
 * @endcode
 */
class AudioTap {
public:
    /**
     * @brief 构造函数 - 通过 UUID 创建 AudioTap 对象
     *
     * @param tapUUID Process Tap 的 UUID（CFUUIDRef）
     *
     * @note UUID 的所有权转移给 AudioTap 对象
     * @note 构造时会查询 TapID 和初始配置
     */
    explicit AudioTap(CFUUIDRef tapUUID);

    /**
     * @brief 析构函数 - RAII 自动清理
     *
     * 释放 UUID 和移除属性监听器（如果有）。
     */
    ~AudioTap();

    // 禁止拷贝和移动
    AudioTap(const AudioTap&) = delete;
    AudioTap& operator=(const AudioTap&) = delete;
    AudioTap(AudioTap&&) = delete;
    AudioTap& operator=(AudioTap&&) = delete;

    // ==================== 基本信息查询 ====================

    /**
     * @brief 获取 Tap 的 UUID（字符串形式）
     * @return UUID 字符串
     */
    std::string getUID() const;

    /**
     * @brief 获取 Tap 的 UUID（CFUUIDRef）
     * @return CFUUIDRef（非拥有指针）
     */
    CFUUIDRef getUUID() const { return tapUUID_; }

    /**
     * @brief 获取 Tap 的 AudioObjectID
     * @return TapID，如果未找到返回 kAudioObjectUnknown
     */
    AudioObjectID getTapID() const { return tapID_; }

    /**
     * @brief 获取 Tap 的音频格式信息
     * @return 格式字符串（如 "stereo, Float32, 48kHz"）
     */
    std::string getFormat() const;

    // ==================== 配置管理 ====================

    /**
     * @brief 获取当前 Tap 配置
     *
     * 从 CoreAudio 查询最新的 kAudioTapPropertyDescription，
     * 转换为 TapConfig 结构体。
     *
     * @return 当前配置
     */
    TapConfig getConfig() const;

    /**
     * @brief 更新 Tap 配置（读-修改-写模式）
     *
     * 将 TapConfig 转换为 CATapDescription，
     * 使用 AudioObjectSetPropertyData 写入 CoreAudio。
     *
     * @param newConfig 新的配置
     * @return 成功返回 true，失败返回 false
     *
     * @warning Phase 4.8: 此方法使用读-修改-写模式，可能导致竞态条件
     * @see updateConfigDirect() 推荐在单进程模式下使用
     */
    bool updateConfig(const TapConfig& newConfig);

    /**
     * @brief 直接更新 Tap 配置（Phase 4.8 新增）
     *
     * 直接创建新的 CATapDescription 并写入 CoreAudio，
     * 不读取旧配置，避免读-修改-写竞态条件。
     *
     * @param newConfig 新的配置
     * @return 成功返回 true，失败返回 false
     *
     * @note Phase 4.8: 用于解决单进程模式下的进程累积问题
     * @note 适用场景：单进程模式的完全替换（不需要保留旧状态）
     * @note 不适用场景：全局模式的增量添加（需要保留现有进程列表）
     */
    bool updateConfigDirect(const TapConfig& newConfig);

    /**
     * @brief 检查 Tap 是否为私有
     * @return true - 私有，false - 公开
     */
    bool isPrivate() const;

    /**
     * @brief 检查 Tap 是否独占模式
     * @return true - 独占，false - 非独占
     */
    bool isExclusive() const;

    // ==================== 观察者模式（可选） ====================

    /**
     * @brief 添加配置变化观察者
     *
     * 注册观察者，当 Tap 配置变化时接收通知。
     *
     * @param observer 观察者指针
     *
     * @note Phase 2: 接口定义完成，但暂不启用监听（为未来 GUI 准备）
     */
    void addConfigObserver(PropertyObserver* observer);

    /**
     * @brief 移除配置变化观察者
     *
     * @param observer 观察者指针
     */
    void removeConfigObserver(PropertyObserver* observer);

private:
    // ==================== 私有方法 ====================

    /**
     * @brief 查找 UUID 对应的 TapID
     *
     * 查询系统所有 Tap（kAudioHardwarePropertyTapList），
     * 找到与 tapUUID_ 匹配的 TapID。
     *
     * @return AudioObjectID，未找到返回 kAudioObjectUnknown
     */
    AudioObjectID findTapID();

    /**
     * @brief 从 CoreAudio 读取 TapDescription
     *
     * 使用 kAudioTapPropertyDescription 查询 Tap 配置。
     *
     * @param outDescription 输出的 CFDictionaryRef（CATapDescription）
     * @return 成功返回 true
     */
    bool readTapDescription(CFDictionaryRef& outDescription) const;

    /**
     * @brief 写入 TapDescription 到 CoreAudio
     *
     * 使用 kAudioTapPropertyDescription 更新 Tap 配置。
     *
     * @param description 要写入的 CFDictionaryRef（CATapDescription）
     * @return 成功返回 true
     */
    bool writeTapDescription(CFDictionaryRef description);

    /**
     * @brief 设置配置变化监听器（可选）
     *
     * @note Phase 2: 暂不实现，为未来 GUI 准备
     */
    bool setupConfigListener();

    /**
     * @brief 移除配置变化监听器
     */
    void removeConfigListener();

    /**
     * @brief 通知观察者
     */
    void notifyObservers(const AudioObjectPropertyAddress& address);

    /**
     * @brief CoreAudio 属性监听回调（静态 C 函数）
     */
    static OSStatus propertyListenerCallback(
        AudioObjectID inObjectID,
        UInt32 inNumberAddresses,
        const AudioObjectPropertyAddress inAddresses[],
        void* inClientData);

    // ==================== 成员变量 ====================

    CFUUIDRef tapUUID_;                          // Tap UUID（拥有所有权）
    AudioObjectID tapID_;                        // CoreAudio TapID
    std::vector<PropertyObserver*> observers_;   // 配置观察者列表
    bool listenerSetup_;                         // 监听器是否已设置
};

} // namespace bitbook::business

#endif // AUDIO_TAP_H
