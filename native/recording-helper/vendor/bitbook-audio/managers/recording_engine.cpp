#include "recording_engine.h"
#include "audio_device_manager.h"
#include "system_resource_manager.h"
#include <iostream>
#include <chrono>

using namespace bitbook::utils;
using namespace bitbook::business;

/**
 * RecordingEngine 实现
 *
 * 对应 Apple 官方示例：
 * - Model.swift: startRecording(), stopRecording()
 * - Model.swift: processStopped() (autoStop 实现)
 *
 * V1.1 更新:
 * - 使用 AudioProcess 类监控进程状态 (替代 kill(pid, 0))
 * - 使用 Logger 替代 std::cout/std::cerr
 * - autoStop 从 aggregateDevice.autoStop 迁移到 runtime.autoStopOnProcessExit
 */

// 构造函数
RecordingEngine::RecordingEngine(const RecordingConfig& config)
    : config_(config)
    , lastError_("")
    , isRecording_(false)
    , currentTapMode_(TapMode::GlobalMode)        // Phase 4.8: 默认全局模式
    , isEventDrivenEnabled_(true)                 // Phase 4.8: 默认启用 EventDriven
    , shouldStop_(false)
    , autoStopTriggered_(false) {
}

// 析构函数（自动清理资源）
RecordingEngine::~RecordingEngine() {
    stop();
    removeDefaultOutputDeviceListener();

    // Phase 4.2: ProcessMonitor 自动清理（RAII）
    // 不再需要手动移除观察者
}

// 设置录制环境
bool RecordingEngine::setup() {
    // 1. 验证配置
    if (!config_.isValid()) {
        setError("RecordingConfig 验证失败");
        Logger::error(lastError_);
        return false;
    }

    if (config_.sources.empty()) {
        setError("配置中没有音频源（sources 为空）");
        Logger::error(lastError_);
        return false;
    }

    Logger::info("🎬 RecordingEngine: 设置录制环境");
    Logger::info("   录制模式: 根据 sources 动态选择");

    // ==================== Phase 4.2: 进程监控重构 ====================
    // 创建 ProcessMonitor（支持多进程监控）
    processMonitor_ = std::make_unique<ProcessMonitor>();

    // 2. 创建 Process Tap（固定流程）
    pid_t pid = config_.getProcessTapPid();

    // ✅ Phase 4: 支持创建空 Tap（PID=0 时创建不绑定进程的 Tap）
    if (config_.hasProcessTap()) {
        // ==================== 全局模式检测 ====================
        if (pid == 0 || pid == -1) {
            Logger::info("🌐 RecordingEngine: 启用全局音频捕获模式");

            // ✅ 关键修复：参考 audiotee 项目
            // 空进程列表 + isExclusive=true = 捕获所有系统音频
            // 不需要加载所有进程列表！
            config_.tap.processes.clear();  // 确保进程列表为空
            config_.tap.isExclusive = true; // 设置 isExclusive=true

            Logger::info("✅ 全局模式：使用空进程列表 + isExclusive=true");
            Logger::info("   这将捕获所有系统音频（参考 audiotee 实现）");
        }
        // ==================== 结束全局模式 ====================

        // 配置中包含 ProcessTap 源，创建 Tap
        if (!setupProcessTap()) {
            return false;
        }

        // 只有在 PID > 0 且启用 autoStop 时才监控进程
        if (pid > 0 && config_.runtime.autoStopOnProcessExit) {
            Logger::infof("   启用 autoStopOnProcessExit，添加进程 %d 到监控器", pid);

            // 注册观察者到 ProcessMonitor
            processMonitor_->addObserver(this);

            // 开始监控进程
            if (!processMonitor_->startMonitoring(pid)) {
                Logger::warningf("⚠️  无法监控 PID %d（可能无音频输出）", pid);
                Logger::warning("   将继续创建设备，但 autoStop 功能将不可用");
            } else {
                Logger::infof("✅ 已启动进程监控 (PID=%d)", pid);
            }
        } else if (pid == 0 || pid == -1) {
            // ✅ PID=0/-1: 全局模式（进程监控由 MonitorThread 负责）
            Logger::info("   全局模式：进程监控由 MonitorThread 负责");
        }
    } else {
        // 配置中没有 ProcessTap 源（纯麦克风模式）
        Logger::info("   配置中无 ProcessTap，跳过 Tap 创建（纯麦克风模式）");
    }

    // 3. 创建 Aggregate Device
    if (!setupAggregateDevice()) {
        return false;
    }

    // 4. 添加音频源（Tap 和/或麦克风）
    if (!addAudioSources()) {
        return false;
    }

    // 5. 设置 Aggregate Device 属性监听（对标 Apple 官方示例）
    if (!deviceManager_->setupPropertyListeners()) {
        Logger::warning("⚠️  设置 Aggregate Device 属性监听失败（不影响录制）");
    }

    // 6. 创建并设置 AudioRecorderV4
    if (!setupRecorder()) {
        return false;
    }

    // 7. 监听默认输出设备变化，处理“录音开始后再切到耳机/蓝牙输出”的场景
    if (!setupDefaultOutputDeviceListener()) {
        Logger::warning("⚠️  设置默认输出设备监听失败（不影响当前录制）");
    }

    Logger::info("✅ RecordingEngine: 设置完成");
    return true;
}

// 开始录制
bool RecordingEngine::start() {
    if (isRecording_) {
        setError("录制已在进行中");
        Logger::error(lastError_);
        return false;
    }

    if (!recorder_) {
        setError("AudioRecorderV4 未初始化，请先调用 setup()");
        Logger::error(lastError_);
        return false;
    }

    Logger::info("🎬 RecordingEngine: 开始录制");

    // 1. 启动 AudioRecorderV4
    autoStopTriggered_ = false;
    if (!recorder_->start()) {
        setError("启动 AudioRecorderV4 失败");
        Logger::error(lastError_);
        return false;
    }

    isRecording_ = true;
    shouldStop_ = false;

    Logger::info("✅ RecordingEngine: 录制已开始（用户主动控制停止）");

    // Phase 4.2: 输出 autoStop 状态
    if (config_.runtime.autoStopOnProcessExit && processMonitor_) {
        size_t monitoredCount = processMonitor_->getMonitoredProcesses().size();
        if (monitoredCount > 0) {
            Logger::infof("   autoStopOnProcessExit 已启用，监控 %zu 个进程", monitoredCount);
        }
    }

    return true;
}

// 停止录制
void RecordingEngine::stop() {
    Logger::info("🛑 RecordingEngine: 停止录制");

    // 1. 设置停止标志
    shouldStop_ = true;

    // 2. 停止 AudioRecorderV4（总是调用，recorder 自己会处理幂等性）
    if (recorder_) {
        Logger::info("   停止录音器");
        recorder_->stop();
    }

    // 3. 清理资源（Manager 会在析构时自动清理）
    isRecording_ = false;

    Logger::info("✅ RecordingEngine: 已停止录制");
}

// 等待录制完成
void RecordingEngine::waitForCompletion() {
    if (!isRecording_) {
        return;
    }

    Logger::info("⏳ RecordingEngine: 等待录制完成...");

    // 等待停止信号
    while (!shouldStop_ && isRecording_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // 如果尚未停止，调用 stop()
    if (isRecording_) {
        stop();
    }
}

bool RecordingEngine::setupDefaultOutputDeviceListener() {
    if (!config_.hasProcessTap() || !tapManager_ || !tapManager_->getTap()) {
        return true;
    }

    if (outputDeviceListenerSetup_) {
        return true;
    }

    auto tapConfig = tapManager_->getTap()->getConfig();
    if (tapConfig.mixdownMode != TapConfig::MixdownMode::DeviceFormat) {
        Logger::info("RecordingEngine: 当前 Tap 未绑定具体输出设备，跳过默认输出监听");
        return true;
    }

    boundOutputDeviceUID_ = tapConfig.deviceUID.value_or("");

    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    OSStatus err = AudioObjectAddPropertyListener(
        kAudioObjectSystemObject,
        &address,
        defaultOutputDeviceListenerProc,
        this
    );

    if (err != noErr) {
        Logger::errorf("RecordingEngine: 添加默认输出设备监听失败: %d", err);
        return false;
    }

    outputDeviceListenerSetup_ = true;
    Logger::infof("✅ RecordingEngine: 已监听默认输出设备变化，当前绑定 UID=%s",
                  boundOutputDeviceUID_.empty() ? "(empty)" : boundOutputDeviceUID_.c_str());
    return true;
}

void RecordingEngine::removeDefaultOutputDeviceListener() {
    if (!outputDeviceListenerSetup_) {
        return;
    }

    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    AudioObjectRemovePropertyListener(
        kAudioObjectSystemObject,
        &address,
        defaultOutputDeviceListenerProc,
        this
    );

    outputDeviceListenerSetup_ = false;
    Logger::info("RecordingEngine: 已移除默认输出设备监听");
}

OSStatus RecordingEngine::defaultOutputDeviceListenerProc(AudioObjectID inObjectID,
                                                          UInt32 inNumberAddresses,
                                                          const AudioObjectPropertyAddress inAddresses[],
                                                          void* inClientData) {
    auto* engine = static_cast<RecordingEngine*>(inClientData);
    if (!engine) {
        return noErr;
    }

    for (UInt32 i = 0; i < inNumberAddresses; ++i) {
        if (inAddresses[i].mSelector == kAudioHardwarePropertyDefaultOutputDevice) {
            engine->handleDefaultOutputDeviceChanged();
        }
    }

    return noErr;
}

void RecordingEngine::handleDefaultOutputDeviceChanged() {
    if (!config_.hasProcessTap() || !tapManager_ || !tapManager_->getTap()) {
        return;
    }

    bool expected = false;
    if (!outputDeviceRebindInProgress_.compare_exchange_strong(expected, true)) {
        Logger::info("RecordingEngine: 默认输出设备重绑已在进行中，跳过重复事件");
        return;
    }

    struct ResetFlag {
        std::atomic<bool>& flag;
        ~ResetFlag() {
            flag.store(false);
        }
    } resetFlag{outputDeviceRebindInProgress_};

    AudioObjectID deviceID = bitbook::AudioDeviceManager::getDefaultOutputDevice();
    if (deviceID == kAudioObjectUnknown) {
        Logger::warning("RecordingEngine: 默认输出设备变化，但无法解析新的输出设备 ID");
        return;
    }

    std::string newOutputDeviceUID = bitbook::AudioDeviceManager::getDeviceUID(deviceID);
    if (newOutputDeviceUID.empty()) {
        Logger::warning("RecordingEngine: 默认输出设备变化，但无法解析新的输出设备 UID");
        return;
    }

    if (newOutputDeviceUID == boundOutputDeviceUID_) {
        Logger::info("RecordingEngine: 默认输出设备事件触发，但绑定 UID 未变化");
        return;
    }

    auto* tap = tapManager_->getTap();
    TapConfig tapConfig = tap->getConfig();
    tapConfig.mixdownMode = TapConfig::MixdownMode::DeviceFormat;
    tapConfig.deviceUID = newOutputDeviceUID;
    tapConfig.streamIndex = 0;

    Logger::infof("🔄 RecordingEngine: 默认输出设备变化，准备重绑 Tap");
    Logger::infof("   旧 UID: %s", boundOutputDeviceUID_.empty() ? "(empty)" : boundOutputDeviceUID_.c_str());
    Logger::infof("   新 UID: %s", newOutputDeviceUID.c_str());

    if (!tap->updateConfig(tapConfig)) {
        Logger::error("RecordingEngine: 默认输出设备变化后重绑 Tap 失败");
        return;
    }

    boundOutputDeviceUID_ = newOutputDeviceUID;

    if (recorder_ && deviceManager_ && deviceManager_->isCreated()) {
        recorder_->adaptToDevice(deviceManager_->getDeviceID());
    }

    Logger::info("✅ RecordingEngine: 已将 Tap 重绑到新的默认输出设备");
}

// PropertyObserver 接口实现（Phase 4.2: 重构为多进程支持）
void RecordingEngine::onPropertyChanged(AudioObjectID objectID,
                                       const AudioObjectPropertyAddress& address) {
    // 只处理 kAudioProcessPropertyIsRunning 属性变化
    if (address.mSelector != kAudioProcessPropertyIsRunning) {
        return;
    }

    // Phase 4.2: 检查是否有任何监控的进程还在运行
    if (!processMonitor_ || !isRecording_) {
        return;
    }

    size_t runningCount = processMonitor_->getRunningCount();

    if (runningCount == 0) {
        if (!autoStopTriggered_.exchange(true)) {
            Logger::warning("🛑 RecordingEngine: 所有监控进程已停止，触发自动停止");
            shouldStop_ = true;
            stop();
        }
    } else {
        Logger::infof("RecordingEngine: 进程状态变化，剩余运行进程数: %zu", runningCount);
    }
}

// 创建 Process Tap
bool RecordingEngine::setupProcessTap() {
    pid_t pid = config_.getProcessTapPid();

    // ✅ Phase 4: 允许 PID=0（创建空 Tap）
    if (pid < 0) {
        setError("ProcessTap PID 无效: " + std::to_string(pid));
        Logger::error(lastError_);
        return false;
    }

    if (pid == 0) {
        Logger::info("🔄 RecordingEngine: 创建空 Process Tap (PID: 0)");
        Logger::info("   Tap 不绑定任何进程，依赖空进程列表 + isExclusive=true 捕获全局系统音频");
    } else {
        Logger::infof("🔄 RecordingEngine: 创建 Process Tap (PID: %d)", pid);
    }

    // 创建 ProcessTapManager（支持 PID=0）
    tapManager_ = std::make_unique<ProcessTapManager>(config_.tap, pid);

    // 创建 Tap
    if (!tapManager_->createTap()) {
        setError("创建 Process Tap 失败: " + tapManager_->getLastError());
        Logger::error(lastError_);
        return false;
    }

    Logger::info("✅ RecordingEngine: Process Tap 创建成功");
    return true;
}

// 创建 Aggregate Device
bool RecordingEngine::setupAggregateDevice() {
    Logger::info("🔄 RecordingEngine: 创建 Aggregate Device");

    // 固定流程：仅在需要麦克风时获取并保存 UID
    microphoneUID_.clear();
    if (config_.hasMicrophone()) {
        microphoneUID_ = config_.getMicrophoneDeviceUID();

        // 如果未指定 UID，使用默认输入设备
        if (microphoneUID_.empty()) {
            Logger::info("   检测系统默认麦克风...");
            AudioObjectID micID = bitbook::AudioDeviceManager::getDefaultInputDevice();
            if (micID == kAudioObjectUnknown) {
                setError("未找到系统默认输入设备（麦克风）");
                Logger::error(lastError_);
                return false;
            }
            microphoneUID_ = bitbook::AudioDeviceManager::getDeviceUID(micID);
            if (microphoneUID_.empty()) {
                setError("无法获取默认麦克风的 UID");
                Logger::error(lastError_);
                return false;
            }
            Logger::infof("   使用默认麦克风: %s", microphoneUID_.c_str());
        }
    } else {
        Logger::info("   配置中无麦克风，跳过默认麦克风选择");
    }

    // 创建 AggregateDeviceManager
    deviceManager_ = std::make_unique<AggregateDeviceManager>(config_.aggregateDevice);

    // 创建空的 Aggregate Device（不包含 SubDeviceList 和 TapList）
    // 对标 Apple 官方示例：设备和 Tap 都使用 AudioObjectSetPropertyData 动态添加
    if (!deviceManager_->createDevice({})) {
        setError("创建 Aggregate Device 失败: " + deviceManager_->getLastError());
        Logger::error(lastError_);
        return false;
    }

    Logger::info("✅ RecordingEngine: Aggregate Device 创建成功（空配置）");

    return true;
}

// 添加音频源到 Aggregate Device
bool RecordingEngine::addAudioSources() {
    Logger::info("🔄 RecordingEngine: 添加音频源到设备");

    // 步骤 1: 添加麦克风（如需要）
    // 注意：麦克风必须先于 Tap 添加，这样麦克风是 Stream 0，Tap 是 Stream 1
    if (config_.hasMicrophone()) {
        if (microphoneUID_.empty()) {
            setError("麦克风 UID 为空（内部错误）");
            Logger::error(lastError_);
            return false;
        }

        Logger::infof("   动态添加麦克风: %s", microphoneUID_.c_str());
        if (!deviceManager_->addMicrophone(microphoneUID_)) {
            setError("动态添加麦克风失败: " + deviceManager_->getLastError());
            Logger::error(lastError_);
            return false;
        }
        Logger::info("✅ RecordingEngine: 麦克风已动态添加");
    } else {
        Logger::info("   无麦克风源，跳过麦克风添加");
    }

    // 步骤 2: 添加 Process Tap（如果存在）
    // ✅ 修复：允许 PID 0 时跳过 Tap 添加
    if (tapManager_) {
        CFUUIDRef tapUUID = tapManager_->getTapUUID();
        if (!tapUUID) {
            setError("Tap UUID 无效");
            Logger::error(lastError_);
            return false;
        }

        Logger::info("   动态添加 Tap...");
        if (!deviceManager_->addTap(tapUUID)) {
            setError("动态添加 Tap 失败: " + deviceManager_->getLastError());
            Logger::error(lastError_);
            return false;
        }
        Logger::info("✅ RecordingEngine: Process Tap 已动态添加");
    } else {
        Logger::info("   无 Tap Manager，跳过 Tap 添加");
    }

    return true;
}

// 创建并设置 AudioRecorderV4
bool RecordingEngine::setupRecorder() {
    Logger::info("🔄 RecordingEngine: 设置 AudioRecorderV4");

    if (!deviceManager_ || !deviceManager_->isCreated()) {
        setError("Aggregate Device 未创建");
        Logger::error(lastError_);
        return false;
    }

    AudioObjectID deviceID = deviceManager_->getDeviceID();

    // 创建音频格式（48kHz, Float32, 立体声）
    // 注意：未来重构时，格式应该从设备读取而不是硬编码
    AudioStreamBasicDescription format = {};
    format.mSampleRate = 48000.0;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    format.mBitsPerChannel = 32;
    format.mChannelsPerFrame = 2;  // 立体声
    format.mBytesPerFrame = format.mChannelsPerFrame * sizeof(float);
    format.mFramesPerPacket = 1;
    format.mBytesPerPacket = format.mBytesPerFrame;

    // 使用基础路径，AudioRecorderV4 会自动为每个流添加后缀
    std::string outputBasePath = config_.recorder.outputBasePath;

    Logger::infof("   输出基础路径: %s", outputBasePath.c_str());
    Logger::infof("   设备 ID: %u", deviceID);

    // Phase 3A.4: 获取进程名用于语义化文件命名
    // Phase 4.2: 从 ProcessTapManager 获取进程名（如果有）
    std::string processName = "";
    if (tapManager_ && tapManager_->getProcess()) {
        processName = tapManager_->getProcess()->getProcessName();
        Logger::infof("   [Phase 3A.4] 进程名: %s", processName.c_str());
    }

    // 创建 AudioRecorderV4
    // Phase 3A.4: 传递 RecorderConfig 和进程名支持语义化文件命名
    recorder_ = std::make_unique<bitbook::AudioRecorderV4>(
        outputBasePath,
        deviceID,
        format,
        &config_.recorder,  // 传递 RecorderConfig 指针
        processName         // 传递进程名
    );

    // ✅ 对齐 Apple 官方示例：轮询检查流是否准备好
    // 官方示例通过属性监听器自动重新扫描，我们使用轮询模拟
    Logger::info("🔍 RecordingEngine: 轮询检查流是否准备好...");

    const int maxRetries = 20;  // 最多等待 2 秒

    // 根据配置动态确定期望的流数量
    int expectedStreams = 0;
    bool hasTap = config_.hasProcessTap();
    if (config_.hasMicrophone()) {
        expectedStreams += 1;
    }
    if (hasTap) {
        expectedStreams += 1;
    }

    Logger::infof("   期望流数量: %d (%s)",
                 expectedStreams,
                 hasTap && config_.hasMicrophone() ? "麦克风 + Tap" :
                 hasTap ? "仅 Tap" : "仅麦克风");

    int retryCount = 0;
    bool streamsReady = false;

    while (retryCount < maxRetries) {
        // 扫描设备流
        recorder_->catalogDeviceStreams();

        size_t inputCount = recorder_->getInputStreamCount();
        Logger::infof("   检查 #%d/%d: 检测到 %zu 个输入流",
                     retryCount + 1, maxRetries, inputCount);

        if (inputCount >= static_cast<size_t>(expectedStreams)) {
            streamsReady = true;
            Logger::info("✅ RecordingEngine: 流已准备好");
            break;
        }

        // 等待 100ms 后重试
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        retryCount++;
    }

    if (!streamsReady) {
        size_t finalCount = recorder_->getInputStreamCount();
        Logger::warningf("⚠️ RecordingEngine: 流准备超时（检测到 %zu 个，期望 %d 个）",
                        finalCount, expectedStreams);

        // ✅ 关键修复：参考 audiotee 项目
        // 只有 Tap 时，流可能暂时不存在，需要等待音频播放才会出现
        // 这是 Process Tap 的正常行为，不是错误

        if (finalCount == 0 && config_.hasMicrophone()) {
            // 有麦克风配置但检测不到任何流，这是真正的错误
            setError("流准备超时，未检测到任何输入流（包括麦克风）");
            Logger::error(lastError_);
            return false;
        } else if (finalCount == 0 && hasTap && !config_.hasMicrophone()) {
            // ✅ 只有 Tap 没有麦克风：这是正常的
            // 参考 audiotee：Tap 流需要有音频播放才会出现
            Logger::warning("   只有 Tap 模式：暂时没有检测到流");
            Logger::warning("   这是正常的：Tap 流需要有音频播放才会激活");
            Logger::warning("   当有音频播放时，PropertyObserver 会自动触发流重建");
            Logger::info("✅ RecordingEngine: 继续录制（等待 Tap 流自动出现）");
        } else {
            // 至少有 1 个流（麦克风），继续录制
            if (hasTap && config_.hasMicrophone() && finalCount == 1) {
                Logger::warning("   只检测到麦克风流，Tap 流尚未出现");
                Logger::warning("   这是正常的：Tap 流需要有音频播放才会激活");
                Logger::warning("   当有音频播放时，PropertyObserver 会自动触发流重建");
            }
            Logger::info("✅ RecordingEngine: 继续录制（等待 Tap 流自动出现）");
        }
    }

    // 调用 setup（此时流已被扫描）
    if (!recorder_->setup()) {
        setError("AudioRecorderV4 setup 失败");
        Logger::error(lastError_);
        return false;
    }

    // Phase 4.6: 注册 AudioRecorderV4 为属性观察者
    // 让它能够接收 AggregateDeviceManager 的设备变化通知
    deviceManager_->addPropertyObserver(recorder_.get());
    Logger::info("✅ RecordingEngine: AudioRecorderV4 已注册为属性观察者");

    // 如果 PCM stdout 已启用，传递给 recorder
    if (pcmStdoutEnabled_) {
        recorder_->enablePcmStdout(pcmStdoutSampleRate_, pcmStdoutChannels_);
    }

    Logger::info("✅ RecordingEngine: AudioRecorderV4 已设置");
    Logger::infof("   输入流数量: %zu", recorder_->getInputStreamCount());
    Logger::infof("   输出流数量: %zu", recorder_->getOutputStreamCount());

    return true;
}

// ==================== Phase 4: 动态进程管理实现 ====================

bool RecordingEngine::addProcessToTap(AudioObjectID processID) {
    // 1. 检查 Tap 是否已创建
    if (!tapManager_ || !tapManager_->getTap()) {
        setError("Tap 未创建，无法添加进程");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    // 2. 获取当前 Tap 配置
    bitbook::business::AudioTap* tap = tapManager_->getTap();
    TapConfig currentConfig = tap->getConfig();

    // 3. 检查进程是否已存在
    if (currentConfig.processes.find(processID) != currentConfig.processes.end()) {
        Logger::warningf("RecordingEngine: 进程 %u 已在 Tap 列表中，跳过添加", processID);
        return true;  // 幂等操作，返回成功
    }

    // 4. 添加性能警告（软限制，不阻止操作）
    if (currentConfig.processes.size() >= 15) {
        Logger::warningf("⚠️  RecordingEngine: 当前 Tap 包含 %zu 个进程，可能影响系统性能",
                        currentConfig.processes.size() + 1);
    }

    // 5. 添加新进程到配置
    currentConfig.processes.insert(processID);

    // 6. 更新 Tap 配置
    Logger::infof("RecordingEngine: 添加进程 %u 到 Tap，当前共 %zu 个进程",
                 processID, currentConfig.processes.size());

    if (!tap->updateConfig(currentConfig)) {
        setError("添加进程失败: Tap 配置更新失败");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    Logger::infof("✅ RecordingEngine: 成功添加进程 %u 到 Tap", processID);
    return true;
}

bool RecordingEngine::removeProcessFromTap(AudioObjectID processID) {
    // 1. 检查 Tap 是否已创建
    if (!tapManager_ || !tapManager_->getTap()) {
        setError("Tap 未创建，无法移除进程");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    // 2. 获取当前 Tap 配置
    bitbook::business::AudioTap* tap = tapManager_->getTap();
    TapConfig currentConfig = tap->getConfig();

    // 3. 检查进程是否存在
    if (currentConfig.processes.find(processID) == currentConfig.processes.end()) {
        Logger::warningf("RecordingEngine: 进程 %u 不在 Tap 列表中，跳过移除", processID);
        return true;  // 幂等操作，返回成功
    }

    // 4. 移除进程
    currentConfig.processes.erase(processID);

    // 5. 更新 Tap 配置
    Logger::infof("RecordingEngine: 从 Tap 移除进程 %u，剩余 %zu 个进程",
                 processID, currentConfig.processes.size());

    if (!tap->updateConfig(currentConfig)) {
        setError("移除进程失败: Tap 配置更新失败");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    Logger::infof("✅ RecordingEngine: 成功从 Tap 移除进程 %u", processID);
    return true;
}

bool RecordingEngine::setTapProcesses(const std::set<AudioObjectID>& processes) {
    // 1. 检查 Tap 是否已创建
    if (!tapManager_ || !tapManager_->getTap()) {
        setError("Tap 未创建，无法设置进程列表");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    // 2. 添加性能警告（软限制，不阻止操作）
    if (processes.size() > 15) {
        Logger::warningf("⚠️  RecordingEngine: 设置 %zu 个进程到 Tap，可能影响系统性能",
                        processes.size());
    }

    // ==================== Phase 4.8: 模式识别逻辑 ====================

    // 3. 判断新模式（根据进程数量）
    TapMode newMode = (processes.size() == 1) ? TapMode::SingleProcess : TapMode::GlobalMode;
    TapMode oldMode = currentTapMode_;

    // 4. 模式切换检测和日志
    if (newMode != oldMode) {
        Logger::infof("🔄 RecordingEngine: 检测到模式切换: %s → %s",
                     (oldMode == TapMode::SingleProcess ? "SingleProcess" : "GlobalMode"),
                     (newMode == TapMode::SingleProcess ? "SingleProcess" : "GlobalMode"));
    }

    // 5. 单进程模式：禁用 EventDriven，使用直接更新
    if (newMode == TapMode::SingleProcess) {
        Logger::infof("📌 RecordingEngine: 单进程模式 - 禁用 EventDriven，完全替换进程列表");
        isEventDrivenEnabled_ = false;
    }
    // 6. 全局模式：启用 EventDriven
    else {
        if (processes.empty()) {
            Logger::info("🌐 RecordingEngine: 全局模式（空列表）- 启用 EventDriven");
        } else {
            Logger::infof("🌐 RecordingEngine: 全局模式（%zu 进程）- 启用 EventDriven", processes.size());
        }
        isEventDrivenEnabled_ = true;
    }

    // 7. 更新模式状态
    currentTapMode_ = newMode;

    // ==================== 配置更新（使用 updateConfigDirect）====================

    // 8. 获取当前配置并更新进程列表
    bitbook::business::AudioTap* tap = tapManager_->getTap();
    TapConfig newConfig = tap->getConfig();
    newConfig.processes = processes;

    // 9. 使用 updateConfigDirect() 避免读-修改-写竞态条件
    Logger::info("RecordingEngine: 使用 updateConfigDirect() 完全替换进程列表");

    if (!tap->updateConfigDirect(newConfig)) {
        setError("设置进程列表失败: Tap 配置更新失败");
        Logger::error("RecordingEngine: " + lastError_);
        return false;
    }

    Logger::infof("✅ RecordingEngine: 进程列表设置成功（模式=%s, EventDriven=%s）",
                 (currentTapMode_ == TapMode::SingleProcess ? "SingleProcess" : "GlobalMode"),
                 (isEventDrivenEnabled_ ? "enabled" : "disabled"));
    return true;
}

bool RecordingEngine::setTapToGlobalMode() {
    Logger::info("RecordingEngine: 切换到全局模式");
    return setTapProcesses(std::set<AudioObjectID>());  // 空列表 = 全局模式
}

std::set<AudioObjectID> RecordingEngine::getTapProcesses() const {
    // 1. 检查 Tap 是否已创建
    if (!tapManager_ || !tapManager_->getTap()) {
        Logger::warning("RecordingEngine: Tap 未创建，返回空进程列表");
        return std::set<AudioObjectID>();
    }

    // 2. 获取当前配置的进程列表
    bitbook::business::AudioTap* tap = tapManager_->getTap();
    TapConfig currentConfig = tap->getConfig();
    return currentConfig.processes;
}

/**
 * 检查进程是否在黑名单中
 * @param processName 进程名称
 * @return true 如果在黑名单中
 */
bool RecordingEngine::isBlacklisted(const std::string& processName) const {
    if (!config_.runtime.enableProcessBlacklist) {
        return false;
    }

    // 硬编码黑名单：视频会议、系统音频等敏感应用
    static const std::vector<std::string> BLACKLIST = {
        "FaceTime",
        "zoom.us",
        "com.apple.VideoConference",
        "com.microsoft.teams2",
        "Skype",
        "com.apple.voicememod",  // Siri
        "Discord",  // 可选：Discord 也可能涉及隐私
        "Slack"     // 可选：Slack 通话
    };

    // 检查进程名是否包含黑名单关键字
    for (const auto& blocked : BLACKLIST) {
        if (processName.find(blocked) != std::string::npos) {
            return true;
        }
    }

    return false;
}

void RecordingEngine::enablePcmStdout(double sampleRate, int channels) {
    pcmStdoutEnabled_ = true;
    pcmStdoutSampleRate_ = sampleRate;
    pcmStdoutChannels_ = channels;
    Logger::infof("RecordingEngine: PCM stdout 流输出已启用 (%.0fHz, %dch)",
                  sampleRate, channels);

    // 如果 recorder 已创建，直接启用
    if (recorder_) {
        recorder_->enablePcmStdout(sampleRate, channels);
    }
}
