#ifndef RECORDING_ENGINE_H
#define RECORDING_ENGINE_H

#include "config/config_types.h"
#include "managers/process_tap_manager.h"
#include "managers/aggregate_device_manager.h"
#include "managers/process_monitor.h"
#include "audio_recorder_v4.h"
#include "business/audio_process.h"
#include "business/property_observer.h"
#include "utils/logger.h"
#include <memory>
#include <string>
#include <thread>
#include <atomic>
#include <CoreAudio/CoreAudio.h>

/**
 * RecordingEngine - 录制引擎（协调层，GUI-only 分支简化版）
 *
 * 职责：协调 ProcessTapManager, AggregateDeviceManager, AudioRecorderV4
 *
 * 对应 Apple 官方示例：
 * - Model.swift: startRecording(), stopRecording()
 * - Model.swift: processStopped() (autoStop 实现)
 *
 * 核心功能：
 * - 根据 sources 动态选择 Tap 和/或 Mic
 * - 协调三个 Manager 的生命周期
 * - 实现 autoStopOnProcessExit 逻辑（监控被 Tap 的进程）
 * - 用户通过 GUI 控制停止（移除 durationSeconds 定时器）
 * - 统一的错误处理
 *
 * 录制流程（Tap + Mic 时的典型路径）：
 *
 * 步骤：ProcessTapManager.createTap() → AggregateDeviceManager.createDevice()
 *       → AggregateDeviceManager.addMicrophone() (Stream 0)
 *       → AggregateDeviceManager.addTap() (Stream 1)
 *       → AudioRecorderV4.start() (多流模式，分离录制)
 *
 * 使用示例：
 * ```cpp
 * RecordingConfig config = ConfigLoader::load("config.json");
 *
 * RecordingEngine engine(config);
 * if (engine.setup()) {
 *     if (engine.start()) {
 *         // 录制进行中...
 *         // 用户通过 GUI 点击停止按钮调用 stop()
 *         // 或进程退出自动停止 (autoStopOnProcessExit)
 *     }
 * } else {
 *     std::cerr << engine.getLastError() << std::endl;
 * }
 * // 析构时自动停止和清理
 * ```
 */
class RecordingEngine : public bitbook::business::PropertyObserver {
public:
    /**
     * 构造函数
     *
     * @param config 完整的录制配置
     */
    explicit RecordingEngine(const RecordingConfig& config);

    /**
     * 析构函数（自动停止录制和清理资源）
     */
    ~RecordingEngine();

    // 禁止拷贝和赋值
    RecordingEngine(const RecordingEngine&) = delete;
    RecordingEngine& operator=(const RecordingEngine&) = delete;

    /**
     * 设置录制环境
     *
     * 步骤：
     * 1. 验证配置有效性
     * 2. 根据 sources 创建对应的 Manager
     * 3. 创建 Process Tap（如果需要）
     * 4. 创建 Aggregate Device
     * 5. 添加 Tap 和/或麦克风到设备
     * 6. 创建 AudioRecorderV4 并 setup
     *
     * @return 成功返回 true，失败返回 false（调用 getLastError() 查看详情）
     */
    bool setup();

    /**
     * 开始录制
     *
     * 步骤：
     * 1. 启动 AudioRecorderV4
     * 2. 启动 durationSeconds 定时器（如果配置 > 0）
     * 3. 启动 autoStop 进程监控（如果配置启用）
     *
     * @return 成功返回 true，失败返回 false
     */
    bool start();

    /**
     * 停止录制
     *
     * 步骤：
     * 1. 停止 AudioRecorderV4
     * 2. 停止定时器和进程监控线程
     * 3. 清理资源（析构 Manager）
     *
     * 此方法是幂等的（多次调用安全）
     */
    void stop();

    /**
     * 等待录制完成
     *
     * 阻塞直到：
     * - durationSeconds 定时器到期（如果配置 > 0）
     * - 或 autoStop 检测到进程停止（如果配置启用）
     * - 或手动调用 stop()
     */
    void waitForCompletion();

    /**
     * 获取最后一次操作的错误信息
     *
     * @return 错误信息字符串
     */
    std::string getLastError() const { return lastError_; }

    /**
     * 检查是否正在录制
     *
     * @return 正在录制返回 true，否则返回 false
     */
    bool isRecording() const { return isRecording_; }

    /**
     * 检查本次录音是否因监控进程退出而自动停止
     */
    bool wasAutoStopped() const { return autoStopTriggered_.load(); }

    // ==================== Phase 4.8: Tap 模式枚举 ====================

    /**
     * Tap 工作模式
     *
     * Phase 4.8: 明确区分两种进程管理模式：
     * - SingleProcess: 单进程模式（完全替换，禁用 EventDriven）
     * - GlobalMode: 全局模式（增量添加，启用 EventDriven）
     */
    enum class TapMode {
        SingleProcess,  // 单进程模式：changeProcess 时完全替换进程列表
        GlobalMode      // 全局模式：通过 EventDriven 增量添加新进程
    };

    // ==================== Phase 4: 动态进程管理 API ====================

    /**
     * 动态添加进程到 Tap
     *
     * 可在录制过程中调用，无需停止录制。
     * 对齐 Apple 官方示例的运行时配置修改功能。
     *
     * @param processID 进程的 AudioObjectID（非 PID）
     * @return 成功返回 true，失败返回 false
     *
     * @note 要求：
     *   1. 必须先调用 setup() 创建 Tap
     *   2. processID 必须是有效的 CoreAudio ProcessID
     *   3. 最多支持 4 个进程（CoreAudio API 限制）
     *
     * @example
     * ```cpp
     * RecordingEngine engine(config);
     * engine.setup();
     * engine.start();
     *
     * // 录制过程中动态添加进程
     * AudioObjectID pid = ...; // 从 SystemResourceManager 获取
     * engine.addProcessToTap(pid);
     * ```
     */
    bool addProcessToTap(AudioObjectID processID);

    /**
     * 动态移除进程
     *
     * 从 Tap 的监听列表中移除指定进程。
     *
     * @param processID 进程的 AudioObjectID
     * @return 成功返回 true，失败返回 false
     */
    bool removeProcessFromTap(AudioObjectID processID);

    /**
     * 批量设置进程列表
     *
     * 替换 Tap 当前的进程列表。
     *
     * @param processes 新的进程列表（AudioObjectID 集合）
     * @return 成功返回 true，失败返回 false
     *
     * @note 空集合表示切换到全局模式（监听所有进程）
     */
    bool setTapProcesses(const std::set<AudioObjectID>& processes);

    /**
     * 切换到全局模式
     *
     * 清空进程列表，监听所有进程的音频输出。
     * 等价于 setTapProcesses({})。
     *
     * @return 成功返回 true
     */
    bool setTapToGlobalMode();

    /**
     * 获取当前 Tap 的进程列表
     *
     * @return 进程 ID 集合，如果 Tap 未创建返回空集合
     */
    std::set<AudioObjectID> getTapProcesses() const;

    /**
     * 检查进程是否在黑名单中
     *
     * @param processName 进程名称
     * @return true 如果在黑名单中
     */
    bool isBlacklisted(const std::string& processName) const;

    /**
     * 启用 PCM stdout 流输出（用于云端实时转写）
     *
     * 在 setup() 之后、start() 之前调用。
     * 启用后，录音数据在写入 WAV 分块文件的同时，
     * 通过 stdout 输出 16bit PCM 流。
     *
     * @param sampleRate 目标采样率（如 16000）
     * @param channels 目标声道数（如 1）
     */
    void enablePcmStdout(double sampleRate, int channels);

    // ==================== Phase 4.8: 模式查询 API ====================

    /**
     * 获取当前 Tap 工作模式
     *
     * @return 当前模式（SingleProcess 或 GlobalMode）
     */
    TapMode getCurrentTapMode() const { return currentTapMode_; }

    /**
     * 查询 EventDriven 监听器是否启用
     *
     * @return true 表示启用（GlobalMode），false 表示禁用（SingleProcess）
     */
    bool isEventDrivenEnabled() const { return isEventDrivenEnabled_; }

    // ==================== PropertyObserver 接口 ====================

    /**
     * PropertyObserver 接口实现
     *
     * 当 AudioProcess 监听的属性变化时调用
     * 用于实现 autoStopOnProcessExit 功能
     *
     * @param objectID CoreAudio 对象 ID (ProcessID)
     * @param address 属性地址
     */
    void onPropertyChanged(AudioObjectID objectID,
                          const AudioObjectPropertyAddress& address) override;

private:
    RecordingConfig config_;                                    // 录制配置
    std::string lastError_;                                     // 最后一次错误信息
    bool isRecording_;                                          // 是否正在录制
    std::string microphoneUID_;                                 // 麦克风设备 UID（用于动态添加）

    // Manager 实例（使用 unique_ptr 管理生命周期）
    std::unique_ptr<ProcessTapManager> tapManager_;             // Process Tap 管理器（可选）
    std::unique_ptr<AggregateDeviceManager> deviceManager_;     // Aggregate Device 管理器
    std::unique_ptr<bitbook::AudioRecorderV4> recorder_;         // 音频录制器

    // ==================== Phase 4.2: 进程监控重构 ====================
    // ❌ 移除：std::unique_ptr<bitbook::business::AudioProcess> audioProcess_;
    // ✅ 新增：进程监控器（支持多进程监控）
    std::unique_ptr<ProcessMonitor> processMonitor_;            // 进程监控器（Phase 4.2）

    // ==================== Phase 4.8: Tap 模式状态 ====================
    TapMode currentTapMode_;                                    // 当前 Tap 工作模式
    bool isEventDrivenEnabled_;                                 // EventDriven 监听器是否启用

    // 停止信号
    std::atomic<bool> shouldStop_;                              // 停止信号
    std::atomic<bool> autoStopTriggered_;                       // 是否因进程退出自动停止

    // PCM stdout 流输出配置
    bool pcmStdoutEnabled_ = false;
    double pcmStdoutSampleRate_ = 16000.0;
    int pcmStdoutChannels_ = 1;

    /**
     * 设置错误信息
     *
     * @param error 错误信息
     */
    void setError(const std::string& error) {
        lastError_ = error;
    }

    /**
     * 创建 Process Tap（固定流程）
     *
     * @return 成功返回 true
     */
    bool setupProcessTap();

    /**
     * 创建 Aggregate Device（固定流程）
     *
     * @return 成功返回 true
     */
    bool setupAggregateDevice();

    /**
     * 添加音频源到 Aggregate Device
     *
     * 固定流程：先添加麦克风 (Stream 0)，再添加 Tap (Stream 1)
     *
     * @return 成功返回 true
     */
    bool addAudioSources();

    /**
     * 创建并设置 AudioRecorderV4
     *
     * @return 成功返回 true
     */
    bool setupRecorder();

    /**
     * 监听系统默认输出设备变化
     *
     * 当用户在录音中途切换到耳机、蓝牙设备等新输出时，
     * 需要重新将 Process Tap 绑定到新的默认输出设备。
     */
    bool setupDefaultOutputDeviceListener();

    /**
     * 移除系统默认输出设备监听
     */
    void removeDefaultOutputDeviceListener();

    /**
     * 处理系统默认输出设备变化
     */
    void handleDefaultOutputDeviceChanged();

    /**
     * CoreAudio 默认输出设备监听回调
     */
    static OSStatus defaultOutputDeviceListenerProc(
        AudioObjectID inObjectID,
        UInt32 inNumberAddresses,
        const AudioObjectPropertyAddress inAddresses[],
        void* inClientData);

    bool outputDeviceListenerSetup_ = false;
    std::atomic<bool> outputDeviceRebindInProgress_{false};
    std::string boundOutputDeviceUID_;
};

#endif // RECORDING_ENGINE_H
