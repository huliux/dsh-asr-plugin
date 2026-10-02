#import "audio_process.h"
#import <libproc.h>
#import <algorithm>
#import <iostream>
#import "../utils/logger.h"

namespace bitbook::business {

// ==================== 构造函数和析构函数 ====================

AudioProcess::AudioProcess(pid_t pid)
    : pid_(pid)
    , processID_(kAudioObjectUnknown)
    , listenerSetup_(false)
{
    // 1. 查找 PID 对应的 ProcessID
    processID_ = findProcessID();

    if (processID_ == kAudioObjectUnknown) {
        std::cerr << "[AudioProcess] Failed to find ProcessID for PID " << pid_ << std::endl;
        return;
    }

    // 2. 设置运行状态监听器
    if (!setupRunningStateListener()) {
        std::cerr << "[AudioProcess] Failed to setup running state listener for PID " << pid_ << std::endl;
    }
}

AudioProcess::~AudioProcess() {
    // 1. 移除监听器
    removeRunningStateListener();

    // 2. 清空观察者列表
    observers_.clear();
}

// ==================== 基本信息查询 ====================

std::string AudioProcess::getProcessName() const {
    char pathbuf[PROC_PIDPATHINFO_MAXSIZE];
    char namebuf[PROC_PIDPATHINFO_MAXSIZE];

    // 使用 proc_name 获取进程名称
    if (proc_name(pid_, namebuf, sizeof(namebuf)) > 0) {
        return std::string(namebuf);
    }

    // 如果 proc_name 失败，尝试使用 proc_pidpath 获取完整路径，然后提取文件名
    if (proc_pidpath(pid_, pathbuf, sizeof(pathbuf)) > 0) {
        std::string path(pathbuf);
        size_t lastSlash = path.find_last_of('/');
        if (lastSlash != std::string::npos) {
            return path.substr(lastSlash + 1);
        }
        return path;
    }

    return "Unknown";
}

bool AudioProcess::isRunning() const {
    if (processID_ == kAudioObjectUnknown) {
        return false;
    }

    // 查询 kAudioProcessPropertyIsRunning 属性
    AudioObjectPropertyAddress address = {
        kAudioProcessPropertyIsRunning,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    // 检查属性是否存在
    if (!AudioObjectHasProperty(processID_, &address)) {
        std::cerr << "[AudioProcess] ProcessID " << processID_
                  << " does not have IsRunning property" << std::endl;
        return false;
    }

    // 查询属性值
    UInt32 isRunning = 0;
    UInt32 size = sizeof(isRunning);
    OSStatus status = AudioObjectGetPropertyData(
        processID_,
        &address,
        0,
        nullptr,
        &size,
        &isRunning
    );

    if (status != noErr) {
        std::cerr << "[AudioProcess] Failed to get IsRunning property: " << status << std::endl;
        return false;
    }

    return isRunning != 0;
}

// ==================== 观察者模式 ====================

void AudioProcess::addRunningStateObserver(PropertyObserver* observer) {
    if (observer == nullptr) {
        std::cerr << "[AudioProcess] Cannot add null observer" << std::endl;
        return;
    }

    observers_.push_back(observer);
}

void AudioProcess::removeRunningStateObserver(PropertyObserver* observer) {
    if (observer == nullptr) {
        return;
    }

    auto it = std::find(observers_.begin(), observers_.end(), observer);
    if (it != observers_.end()) {
        observers_.erase(it);
    }
}

// ==================== 私有方法 ====================

AudioObjectID AudioProcess::findProcessID() {
    // 查询系统所有音频进程列表
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    // 获取进程列表大小
    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject,
        &address,
        0,
        nullptr,
        &dataSize
    );

    if (status != noErr) {
        std::cerr << "[AudioProcess] Failed to get process list size: " << status << std::endl;
        return kAudioObjectUnknown;
    }

    // 获取进程列表
    UInt32 processCount = dataSize / sizeof(AudioObjectID);
    std::vector<AudioObjectID> processIDs(processCount);

    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &address,
        0,
        nullptr,
        &dataSize,
        processIDs.data()
    );

    if (status != noErr) {
        std::cerr << "[AudioProcess] Failed to get process list: " << status << std::endl;
        return kAudioObjectUnknown;
    }

    // 遍历进程列表，查找匹配的 PID
    for (AudioObjectID processID : processIDs) {
        AudioObjectPropertyAddress pidAddress = {
            kAudioProcessPropertyPID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        pid_t processPID = 0;
        UInt32 pidSize = sizeof(processPID);

        status = AudioObjectGetPropertyData(
            processID,
            &pidAddress,
            0,
            nullptr,
            &pidSize,
            &processPID
        );

        if (status == noErr && processPID == pid_) {
            return processID;
        }
    }

    return kAudioObjectUnknown;
}

bool AudioProcess::setupRunningStateListener() {
    if (processID_ == kAudioObjectUnknown) {
        return false;
    }

    if (listenerSetup_) {
        // 监听器已经设置
        return true;
    }

    // 设置监听 kAudioProcessPropertyIsRunning
    AudioObjectPropertyAddress address = {
        kAudioProcessPropertyIsRunning,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    using namespace bitbook::utils;
    // Logger::infof("[AudioProcess] Setting up listener for ProcessID=%u, PID=%d",
    //               processID_, pid_);

    // 检查属性是否存在
    if (!AudioObjectHasProperty(processID_, &address)) {
        Logger::errorf("[AudioProcess] ProcessID %u does not support IsRunning property", processID_);
        return false;
    }

    // Logger::info("[AudioProcess] IsRunning property is supported, adding listener...");

    // 添加监听器
    OSStatus status = AudioObjectAddPropertyListener(
        processID_,
        &address,
        propertyListenerCallback,
        this  // 传递 this 指针作为客户端数据
    );

    if (status != noErr) {
        Logger::errorf("[AudioProcess] Failed to add property listener: OSStatus=%d", status);
        return false;
    }

    listenerSetup_ = true;
    // Logger::info("[AudioProcess] ✅ Property listener successfully added");
    return true;
}

void AudioProcess::removeRunningStateListener() {
    if (!listenerSetup_ || processID_ == kAudioObjectUnknown) {
        return;
    }

    AudioObjectPropertyAddress address = {
        kAudioProcessPropertyIsRunning,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    OSStatus status = AudioObjectRemovePropertyListener(
        processID_,
        &address,
        propertyListenerCallback,
        this
    );

    if (status != noErr) {
        std::cerr << "[AudioProcess] Failed to remove property listener: " << status << std::endl;
    }

    listenerSetup_ = false;
}

void AudioProcess::notifyObservers(const AudioObjectPropertyAddress& address) {
    // 遍历所有观察者并通知
    for (PropertyObserver* observer : observers_) {
        if (observer != nullptr) {
            observer->onPropertyChanged(processID_, address);
        }
    }
}

OSStatus AudioProcess::propertyListenerCallback(
    AudioObjectID inObjectID,
    UInt32 inNumberAddresses,
    const AudioObjectPropertyAddress inAddresses[],
    void* inClientData)
{
    using namespace bitbook::utils;
    Logger::infof("[AudioProcess] Property listener callback triggered: ObjectID=%u, NumAddresses=%u",
                  inObjectID, inNumberAddresses);

    // 将客户端数据转换回 AudioProcess 指针
    AudioProcess* audioProcess = static_cast<AudioProcess*>(inClientData);
    if (audioProcess == nullptr) {
        Logger::warning("[AudioProcess] Property listener callback: inClientData is null");
        return noErr;
    }

    // 通知所有观察者
    for (UInt32 i = 0; i < inNumberAddresses; ++i) {
        Logger::infof("[AudioProcess] Notifying observers for property selector: 0x%x",
                      inAddresses[i].mSelector);
        audioProcess->notifyObservers(inAddresses[i]);
    }

    return noErr;
}

} // namespace bitbook::business
