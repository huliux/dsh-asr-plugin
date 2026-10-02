#ifndef AUDIO_PROCESS_H
#define AUDIO_PROCESS_H

#include "property_observer.h"
#include <CoreAudio/CoreAudio.h>
#include <string>
#include <vector>
#include <memory>

namespace bitbook::business {

/**
 * @brief 音频进程业务对象
 *
 * AudioProcess 类封装了一个音频进程的信息和状态监控功能，使用 CoreAudio
 * Process Tap API 提供的属性监听机制监控进程运行状态。这是业务对象层的核心类，
 * 对标 Apple 官方示例中的 AudioProcess 类。
 *
 * 核心功能:
 * - 封装进程基本信息 (PID, 进程名, ProcessID)
 * - 使用 CoreAudio 属性监听监控进程运行状态 (kAudioProcessPropertyIsRunning)
 * - 实现观察者模式，支持多个观察者注册
 * - RAII 资源管理，自动清理监听器
 *
 * 使用场景:
 * - autoStop 功能: 监听目标进程退出事件，自动停止录制
 * - 进程状态查询: 实时查询进程是否在运行
 * - 系统进程列举: 配合 kAudioHardwarePropertyProcessObjectList 实现
 *
 * 与 Apple 示例对齐:
 * - 对应官方示例的 AudioProcess 类
 * - 使用相同的 CoreAudio 属性监听机制
 * - 支持沙箱环境 (不依赖 kill(pid, 0) 等系统调用)
 *
 * Phase 1 实现范围:
 * - 基本进程信息查询
 * - 运行状态监听 (kAudioProcessPropertyIsRunning)
 * - 观察者模式通知机制
 *
 * Phase 2 扩展计划:
 * - 进程 Tap 列表枚举
 * - 进程音频格式查询
 * - 进程音频设备信息
 *
 * 示例:
 * @code
 * // 创建 AudioProcess 对象
 * auto audioProcess = std::make_unique<AudioProcess>(1234); // PID
 *
 * // 检查进程是否找到
 * if (audioProcess->getProcessID() == kAudioObjectUnknown) {
 *     std::cerr << "Process not found" << std::endl;
 *     return;
 * }
 *
 * // 注册观察者监听进程退出
 * audioProcess->addRunningStateObserver(myObserver);
 *
 * // 查询进程信息
 * std::cout << "Process: " << audioProcess->getProcessName() << std::endl;
 * std::cout << "Running: " << audioProcess->isRunning() << std::endl;
 *
 * // RAII 自动清理: 析构时自动移除监听器和通知观察者
 * @endcode
 */
class AudioProcess {
public:
    /**
     * @brief 构造函数 - 通过 PID 创建音频进程对象
     *
     * 构造时会自动:
     * 1. 查询 PID 对应的 ProcessID (CoreAudio 对象 ID)
     * 2. 设置进程运行状态监听器
     * 3. 初始化成员变量
     *
     * @param pid 进程 ID (BSD 进程 ID, 不是 CoreAudio ProcessID)
     *
     * @note 如果 PID 无效或进程不存在，processID_ 会被设置为 kAudioObjectUnknown
     * @note 构造函数不会抛出异常，需要通过 getProcessID() 检查是否成功
     */
    explicit AudioProcess(pid_t pid);

    /**
     * @brief 析构函数 - RAII 自动清理资源
     *
     * 析构时会自动:
     * 1. 移除 CoreAudio 属性监听器
     * 2. 清空观察者列表
     *
     * @note 遵循 RAII 原则，无需手动清理
     */
    ~AudioProcess();

    // 禁止拷贝和移动 (管理系统资源)
    AudioProcess(const AudioProcess&) = delete;
    AudioProcess& operator=(const AudioProcess&) = delete;
    AudioProcess(AudioProcess&&) = delete;
    AudioProcess& operator=(AudioProcess&&) = delete;

    // ==================== 基本信息查询 ====================

    /**
     * @brief 获取进程 PID (BSD 进程 ID)
     * @return 进程 PID
     */
    pid_t getPID() const { return pid_; }

    /**
     * @brief 获取进程 ProcessID (CoreAudio 对象 ID)
     * @return CoreAudio ProcessID, 如果进程不存在返回 kAudioObjectUnknown
     */
    AudioObjectID getProcessID() const { return processID_; }

    /**
     * @brief 获取进程名称
     *
     * 使用 BSD 系统调用 proc_name() 获取进程名称。
     *
     * @return 进程名称字符串，如果获取失败返回 "Unknown"
     */
    std::string getProcessName() const;

    /**
     * @brief 查询进程是否正在运行
     *
     * 通过查询 CoreAudio 属性 kAudioProcessPropertyIsRunning 判断进程状态。
     * 这是沙箱环境下可靠的进程状态检测方法，对标 Apple 官方示例。
     *
     * @return true - 进程正在运行, false - 进程已退出或不存在
     *
     * @note 此方法是 autoStop 功能的核心实现
     * @note 在沙箱环境中，kill(pid, 0) 不可用，必须使用此方法
     */
    bool isRunning() const;

    // ==================== 观察者模式 ====================

    /**
     * @brief 添加运行状态观察者
     *
     * 注册一个观察者，当进程运行状态发生变化时接收通知。
     * 支持多个观察者同时注册。
     *
     * @param observer 观察者指针 (非拥有指针，调用者负责生命周期管理)
     *
     * @note 不检查重复添加，调用者需要避免重复注册
     * @note 观察者必须在 AudioProcess 对象销毁前保持有效
     */
    void addRunningStateObserver(PropertyObserver* observer);

    /**
     * @brief 移除运行状态观察者
     *
     * 取消注册一个观察者，停止接收进程状态变化通知。
     *
     * @param observer 要移除的观察者指针
     *
     * @note 如果观察者未注册，调用此方法无效果
     */
    void removeRunningStateObserver(PropertyObserver* observer);

private:
    // ==================== 私有方法 ====================

    /**
     * @brief 查找 PID 对应的 ProcessID
     *
     * 查询系统所有音频进程 (kAudioHardwarePropertyProcessObjectList)，
     * 找到与 pid_ 匹配的 ProcessID。
     *
     * @return CoreAudio ProcessID, 如果未找到返回 kAudioObjectUnknown
     */
    AudioObjectID findProcessID();

    /**
     * @brief 设置运行状态监听器
     *
     * 向 CoreAudio 注册属性监听器，监听 kAudioProcessPropertyIsRunning 变化。
     * 使用 C 函数指针作为回调 (propertyListenerCallback)。
     *
     * @return true - 成功, false - 失败
     */
    bool setupRunningStateListener();

    /**
     * @brief 移除运行状态监听器
     *
     * 从 CoreAudio 移除属性监听器，停止监听进程状态变化。
     * 在析构函数中自动调用。
     */
    void removeRunningStateListener();

    /**
     * @brief 通知所有观察者
     *
     * 当进程运行状态变化时，调用此方法通知所有注册的观察者。
     *
     * @param address 变化的属性地址
     */
    void notifyObservers(const AudioObjectPropertyAddress& address);

    /**
     * @brief CoreAudio 属性监听回调函数 (静态 C 函数指针)
     *
     * CoreAudio 属性变化时会调用此函数。此函数将调用转发给对应的
     * AudioProcess 实例的 notifyObservers 方法。
     *
     * @param inObjectID 对象 ID (ProcessID)
     * @param inNumberAddresses 变化的属性数量
     * @param inAddresses 变化的属性地址数组
     * @param inClientData 客户端数据 (指向 AudioProcess 实例的指针)
     * @return OSStatus - noErr 表示成功
     *
     * @note 必须是 C 函数指针，不能是 C++ 成员函数或 Block
     * @note 在 CoreAudio 线程中调用，需要注意线程安全
     */
    static OSStatus propertyListenerCallback(
        AudioObjectID inObjectID,
        UInt32 inNumberAddresses,
        const AudioObjectPropertyAddress inAddresses[],
        void* inClientData);

    // ==================== 成员变量 ====================

    pid_t pid_;                                      // BSD 进程 ID
    AudioObjectID processID_;                        // CoreAudio 对象 ID
    std::vector<PropertyObserver*> observers_;       // 观察者列表 (非拥有指针)
    bool listenerSetup_;                             // 监听器是否已设置
};

} // namespace bitbook::business

#endif // AUDIO_PROCESS_H
