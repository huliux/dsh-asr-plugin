#import "audio_tap.h"
#import "utils/logger.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>

using namespace bitbook::utils;

// CoreAudio Tap 属性键（对应 Apple 官方示例）
static NSString* const kAudioProcessTapNameKey = @"name";
static NSString* const kAudioProcessTapProcessesKey = @"processes";  // 进程列表 (NSArray<NSNumber*>)

namespace bitbook::business {

static std::string NSStringToStdString(NSString* value) {
    if (!value) {
        return "";
    }

    const char* utf8 = [value UTF8String];
    return utf8 ? std::string(utf8) : "";
}

static NSArray<NSNumber*>* BuildProcessArray(const std::set<AudioObjectID>& processes) {
    NSMutableArray<NSNumber*>* processArray = [NSMutableArray arrayWithCapacity:processes.size()];
    for (AudioObjectID processID : processes) {
        [processArray addObject:@(processID)];
    }
    return processArray;
}

static void ApplyMuteBehavior(CATapDescription* tapDesc, TapConfig::MuteBehavior behavior) {
    switch (behavior) {
        case TapConfig::MuteBehavior::Unmuted:
            tapDesc.muteBehavior = CATapUnmuted;
            break;
        case TapConfig::MuteBehavior::Muted:
            tapDesc.muteBehavior = CATapMuted;
            break;
        case TapConfig::MuteBehavior::MutedWhenTapped:
            tapDesc.muteBehavior = CATapMutedWhenTapped;
            break;
    }
}

static void ApplyMixdownConfig(CATapDescription* tapDesc, const TapConfig& config) {
    switch (config.mixdownMode) {
        case TapConfig::MixdownMode::Mono:
            tapDesc.mixdown = YES;
            tapDesc.mono = YES;
            tapDesc.deviceUID = nil;
            tapDesc.stream = @0;
            break;
        case TapConfig::MixdownMode::Stereo:
            tapDesc.mixdown = YES;
            tapDesc.mono = NO;
            tapDesc.deviceUID = nil;
            tapDesc.stream = @0;
            break;
        case TapConfig::MixdownMode::DeviceFormat:
            tapDesc.mixdown = NO;
            tapDesc.mono = NO;
            tapDesc.deviceUID = config.deviceUID.has_value() && !config.deviceUID->empty()
                ? [NSString stringWithUTF8String:config.deviceUID->c_str()]
                : nil;
            tapDesc.stream = @(config.streamIndex);
            break;
    }
}

static void ApplyTapConfig(CATapDescription* tapDesc, const TapConfig& config) {
    tapDesc.name = [NSString stringWithUTF8String:config.name.c_str()];
    tapDesc.processes = BuildProcessArray(config.processes);
    [tapDesc setPrivate:config.isPrivate ? YES : NO];
    tapDesc.exclusive = config.isExclusive ? YES : NO;
    ApplyMuteBehavior(tapDesc, config.muteBehavior);
    ApplyMixdownConfig(tapDesc, config);
}

// ==================== 构造和析构 ====================

AudioTap::AudioTap(CFUUIDRef tapUUID)
    : tapUUID_(tapUUID)
    , tapID_(kAudioObjectUnknown)
    , listenerSetup_(false)
{
    @autoreleasepool {
        if (!tapUUID_) {
            Logger::error("AudioTap: 构造失败，UUID 为空");
            return;
        }

        // 查找 TapID
        tapID_ = findTapID();

        if (tapID_ == kAudioObjectUnknown) {
            Logger::error("AudioTap: 无法找到 UUID 对应的 Tap");
        } else {
            Logger::infof("AudioTap: 成功创建，UID=%s, TapID=%u",
                         getUID().c_str(), tapID_);
        }
    }
}

AudioTap::~AudioTap() {
    @autoreleasepool {
        // 移除属性监听器
        if (listenerSetup_) {
            removeConfigListener();
        }

        // 释放 UUID
        if (tapUUID_) {
            CFRelease(tapUUID_);
            tapUUID_ = nullptr;
        }

        // 清空观察者列表
        observers_.clear();

        Logger::info("AudioTap: 已销毁");
    }
}

// ==================== 基本信息查询 ====================

std::string AudioTap::getUID() const {
    @autoreleasepool {
        if (!tapUUID_) {
            return "";
        }

        CFStringRef uidString = CFUUIDCreateString(kCFAllocatorDefault, tapUUID_);
        if (!uidString) {
            return "";
        }

        NSString* nsString = (__bridge_transfer NSString*)uidString;
        return std::string([nsString UTF8String]);
    }
}

std::string AudioTap::getFormat() const {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            return "N/A";
        }

        // Tap 对象的格式信息需要从 Tap Description 或者通过特殊方式查询
        // 这里暂时返回 N/A，因为 Tap 不支持 kAudioDevicePropertyStreamFormat
        // 格式信息通常继承自目标进程，在录制时才确定

        return "Inherited from process";
    }
}

// ==================== 配置管理 ====================

TapConfig AudioTap::getConfig() const {
    @autoreleasepool {
        TapConfig config;

        if (tapID_ == kAudioObjectUnknown) {
            Logger::error("AudioTap: TapID 无效，无法查询配置");
            return config;  // 返回默认配置
        }

        CFDictionaryRef descriptionRef = nil;
        if (!readTapDescription(descriptionRef)) {
            Logger::error("AudioTap: 读取 Tap 配置失败");
            return config;
        }

        NSDictionary* description = CFBridgingRelease(descriptionRef);
        CATapDescription* tapDesc = description[@"__tapDesc"];
        if (!tapDesc) {
            Logger::error("AudioTap: 配置中未找到 CATapDescription 对象");
            return config;
        }

        config.name = NSStringToStdString(tapDesc.name);
        config.isPrivate = [tapDesc isPrivate];
        config.isExclusive = tapDesc.exclusive;

        switch (tapDesc.muteBehavior) {
            case CATapMuted:
                config.muteBehavior = TapConfig::MuteBehavior::Muted;
                break;
            case CATapMutedWhenTapped:
                config.muteBehavior = TapConfig::MuteBehavior::MutedWhenTapped;
                break;
            case CATapUnmuted:
            default:
                config.muteBehavior = TapConfig::MuteBehavior::Unmuted;
                break;
        }

        NSString* deviceUID = tapDesc.deviceUID;
        if (deviceUID.length > 0) {
            config.deviceUID = NSStringToStdString(deviceUID);
        } else {
            config.deviceUID = std::nullopt;
        }

        NSNumber* streamNumber = tapDesc.stream;
        if (streamNumber != nil) {
            config.streamIndex = static_cast<UInt32>(streamNumber.unsignedIntValue);
        }

        if (config.deviceUID.has_value() && !tapDesc.mixdown) {
            config.mixdownMode = TapConfig::MixdownMode::DeviceFormat;
        } else if (tapDesc.mono) {
            config.mixdownMode = TapConfig::MixdownMode::Mono;
        } else {
            config.mixdownMode = TapConfig::MixdownMode::Stereo;
        }

        NSArray<NSNumber*>* processes = tapDesc.processes;
        if (processes != nil) {
            for (NSNumber* processNumber in processes) {
                config.processes.insert(static_cast<AudioObjectID>(processNumber.unsignedIntValue));
            }
            Logger::infof("AudioTap: 读取进程列表成功，共 %zu 个进程", config.processes.size());
        } else {
            Logger::info("AudioTap: 配置中未找到 processes 字段（可能为空集合）");
        }

        Logger::infof("AudioTap: 配置查询成功，name=%s, isPrivate=%d, processes=%zu",
                     config.name.c_str(), config.isPrivate, config.processes.size());

        return config;
    }
}

bool AudioTap::updateConfig(const TapConfig& newConfig) {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            Logger::error("AudioTap: TapID 无效，无法更新配置");
            return false;
        }

        // ====================================================================
        // ✅ Phase 4: 正确实现（对齐 Apple 官方示例）
        // 关键发现：CATapDescription 必须先读取现有配置，然后修改进程列表
        // 参考：PHASE4_ANALYSIS_SUMMARY.md 第 1.3 节
        // ====================================================================

        Logger::infof("AudioTap: 开始更新配置，进程数=%zu", newConfig.processes.size());

        // 步骤 1: 读取当前 Tap 配置
        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        CATapDescription* currentDesc = nil;
        UInt32 dataSize = sizeof(CATapDescription*);

        OSStatus err = AudioObjectGetPropertyData(
            tapID_,
            &descAddr,
            0,
            nullptr,
            &dataSize,
            &currentDesc
        );

        if (err != kAudioHardwareNoError || !currentDesc) {
            Logger::errorf("AudioTap: 读取当前配置失败，错误码=%d", err);
            return false;
        }

        // 步骤 2: 应用新配置
        ApplyTapConfig(currentDesc, newConfig);
        Logger::infof("AudioTap: 设置进程列表，共 %zu 个进程", newConfig.processes.size());

        // 步骤 4: 写回 CoreAudio（值传递）
        dataSize = sizeof(CATapDescription*);

        err = AudioObjectSetPropertyData(
            tapID_,
            &descAddr,
            0,
            nullptr,
            dataSize,
            &currentDesc
        );

        if (err != kAudioHardwareNoError) {
            Logger::errorf("AudioTap: 写入 Tap 配置失败，错误码=%d (0x%X)", err, err);
            return false;
        }

        // 步骤 5: 成功，记录日志
        Logger::infof("✅ AudioTap: 配置更新成功");
        Logger::infof("   名称: %s", newConfig.name.c_str());
        Logger::infof("   进程数: %zu", newConfig.processes.size());

        return true;
    }
}

// ==================== Phase 4.8: 直接配置更新（避免读-修改-写竞态条件）====================

bool AudioTap::updateConfigDirect(const TapConfig& newConfig) {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            Logger::error("AudioTap: TapID 无效，无法更新配置");
            return false;
        }

        Logger::infof("AudioTap: 开始直接更新配置（不读取旧配置），进程数=%zu", newConfig.processes.size());

        // ====================================================================
        // ✅ Phase 4.8: 直接创建 TapDescription（不读取旧配置）
        // 解决读-修改-写竞态条件：避免与 EventDriven/系统内部状态合并
        // 适用场景：单进程模式的完全替换（不需要保留旧进程列表）
        // ====================================================================

        // 步骤 1: 默认初始化新的 TapDescription，并显式应用完整配置
        CATapDescription* newDesc = [[CATapDescription alloc] init];

        if (!newDesc) {
            Logger::error("AudioTap: 创建 CATapDescription 失败");
            return false;
        }

        ApplyTapConfig(newDesc, newConfig);

        // 步骤 2: 设置 UUID 保持与现有 Tap 一致
        // ⚠️ UUID 必须保持与现有 Tap 一致，不能生成新的
        // 使用已有的 tapUUID_（成员变量）
        CFStringRef uidString = CFUUIDCreateString(kCFAllocatorDefault, tapUUID_);
        if (uidString) {
            newDesc.UUID = [[NSUUID alloc] initWithUUIDString:(__bridge NSString*)uidString];
            CFRelease(uidString);
        } else {
            Logger::warning("⚠️ AudioTap: 无法转换 UUID，使用新 UUID");
            newDesc.UUID = [NSUUID UUID];
        }

        // 步骤 3: 写入 CoreAudio
        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = sizeof(CATapDescription*);
        OSStatus err = AudioObjectSetPropertyData(
            tapID_,
            &descAddr,
            0,
            nullptr,
            dataSize,
            &newDesc
        );

        if (err != kAudioHardwareNoError) {
            Logger::errorf("AudioTap: 直接写入 Tap 配置失败，错误码=%d (0x%X)", err, err);
            return false;
        }

        // 步骤 5: 成功
        Logger::infof("✅ AudioTap: 配置直接更新成功（无读取旧配置）");
        Logger::infof("   名称: %s", newConfig.name.c_str());
        Logger::infof("   进程数: %zu", newConfig.processes.size());

        return true;
    }
}

bool AudioTap::isPrivate() const {
    TapConfig config = getConfig();
    return config.isPrivate;
}

bool AudioTap::isExclusive() const {
    TapConfig config = getConfig();
    return config.isExclusive;
}

// ==================== 观察者模式 ====================

void AudioTap::addConfigObserver(PropertyObserver* observer) {
    if (!observer) {
        return;
    }

    observers_.push_back(observer);
    Logger::info("AudioTap: 添加配置观察者");

    // Phase 2: 暂不启用监听器（为未来 GUI 准备）
    // 如果需要启用，取消下面的注释：
    // if (!listenerSetup_) {
    //     setupConfigListener();
    // }
}

void AudioTap::removeConfigObserver(PropertyObserver* observer) {
    if (!observer) {
        return;
    }

    auto it = std::find(observers_.begin(), observers_.end(), observer);
    if (it != observers_.end()) {
        observers_.erase(it);
        Logger::info("AudioTap: 移除配置观察者");
    }
}

// ==================== 私有方法 ====================

AudioObjectID AudioTap::findTapID() {
    @autoreleasepool {
        if (!tapUUID_) {
            return kAudioObjectUnknown;
        }

        // 1. 获取系统所有 Tap 列表
        AudioObjectPropertyAddress tapListAddr = {
            kAudioHardwarePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &tapListAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warningf("AudioTap: 无法获取 Tap 列表，错误码=%d", err);
            return kAudioObjectUnknown;
        }

        UInt32 numTaps = dataSize / sizeof(AudioObjectID);
        std::vector<AudioObjectID> tapIDs(numTaps);

        err = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &tapListAddr, 0, nullptr, &dataSize, tapIDs.data()
        );

        if (err != noErr) {
            Logger::errorf("AudioTap: 获取 Tap 列表失败，错误码=%d", err);
            return kAudioObjectUnknown;
        }

        Logger::infof("AudioTap: 系统中共有 %u 个 Tap", numTaps);

        // 2. 枚举每个 Tap，比对 UUID
        CFStringRef myUIDString = CFUUIDCreateString(kCFAllocatorDefault, tapUUID_);
        if (!myUIDString) {
            Logger::error("AudioTap: 无法创建 UUID 字符串");
            return kAudioObjectUnknown;
        }

        AudioObjectID foundTapID = kAudioObjectUnknown;

        for (AudioObjectID tapID : tapIDs) {
            CFStringRef tapUIDString = nullptr;
            UInt32 uidSize = sizeof(CFStringRef);

            AudioObjectPropertyAddress uidAddr = {
                kAudioTapPropertyUID,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };

            err = AudioObjectGetPropertyData(tapID, &uidAddr, 0, nullptr, &uidSize, &tapUIDString);

            if (err == noErr && tapUIDString) {
                Boolean match = (CFStringCompare(tapUIDString, myUIDString, 0) == kCFCompareEqualTo);
                CFRelease(tapUIDString);

                if (match) {
                    Logger::infof("AudioTap: 找到匹配的 Tap，TapID=%u", tapID);
                    foundTapID = tapID;
                    break;
                }
            }
        }

        CFRelease(myUIDString);

        if (foundTapID == kAudioObjectUnknown) {
            Logger::error("AudioTap: 未找到匹配的 TapID");
        }

        return foundTapID;
    }
}

bool AudioTap::readTapDescription(CFDictionaryRef& outDescription) const {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            return false;
        }

        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        // 注意：kAudioTapPropertyDescription 返回的是 CATapDescription* (ObjC 对象)
        CATapDescription* tapDesc = nil;
        UInt32 dataSize = sizeof(CATapDescription*);

        OSStatus err = AudioObjectGetPropertyData(
            tapID_, &descAddr, 0, nullptr, &dataSize, &tapDesc
        );

        if (err != noErr || !tapDesc) {
            Logger::errorf("AudioTap: 读取配置失败，错误码=%d", err);
            return false;
        }

        // 将 CATapDescription 包装为 CFDictionary，方便后续处理
        // 注意：这里仅存储 tapDesc 指针，不做深拷贝
        NSMutableDictionary* dict = [NSMutableDictionary dictionary];
        dict[@"__tapDesc"] = tapDesc;  // 存储原始对象
        dict[kAudioProcessTapNameKey] = tapDesc.name;
        dict[kAudioProcessTapProcessesKey] = tapDesc.processes;

        outDescription = (__bridge_retained CFDictionaryRef)dict;
        return true;
    }
}

bool AudioTap::writeTapDescription(CFDictionaryRef description) {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            return false;
        }

        if (!description) {
            Logger::error("AudioTap: 配置字典为空");
            return false;
        }

        // 从字典中获取 CATapDescription 对象
        NSDictionary* dict = (__bridge NSDictionary*)description;
        CATapDescription* tapDesc = dict[@"__tapDesc"];

        if (!tapDesc) {
            Logger::error("AudioTap: 配置字典中未找到 CATapDescription 对象");
            return false;
        }

        // 更新可修改的属性
        // 注意：CATapDescription 的大部分属性是只读的，只有少数可以修改
        // 根据测试，我们主要更新进程列表
        NSArray<NSNumber*>* processes = dict[kAudioProcessTapProcessesKey];
        if (processes) {
            tapDesc.processes = processes;
        }

        // 更新名称（如果提供）
        NSString* name = dict[kAudioProcessTapNameKey];
        if (name) {
            tapDesc.name = name;
        }

        // 写入 CoreAudio
        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        CATapDescription* descToWrite = tapDesc;
        UInt32 dataSize = sizeof(CATapDescription*);

        OSStatus err = AudioObjectSetPropertyData(
            tapID_, &descAddr, 0, nullptr, dataSize, &descToWrite
        );

        if (err != noErr) {
            Logger::errorf("AudioTap: 写入配置失败，错误码=%d", err);
            return false;
        }

        return true;
    }
}

bool AudioTap::setupConfigListener() {
    @autoreleasepool {
        if (tapID_ == kAudioObjectUnknown) {
            return false;
        }

        if (listenerSetup_) {
            return true;  // 已设置
        }

        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        OSStatus err = AudioObjectAddPropertyListener(
            tapID_,
            &descAddr,
            propertyListenerCallback,
            (void*)this
        );

        if (err != noErr) {
            Logger::errorf("AudioTap: 设置配置监听器失败，错误码=%d", err);
            return false;
        }

        listenerSetup_ = true;
        Logger::info("AudioTap: 配置监听器已设置");
        return true;
    }
}

void AudioTap::removeConfigListener() {
    @autoreleasepool {
        if (!listenerSetup_ || tapID_ == kAudioObjectUnknown) {
            return;
        }

        AudioObjectPropertyAddress descAddr = {
            kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        AudioObjectRemovePropertyListener(
            tapID_,
            &descAddr,
            propertyListenerCallback,
            (void*)this
        );

        listenerSetup_ = false;
        Logger::info("AudioTap: 配置监听器已移除");
    }
}

void AudioTap::notifyObservers(const AudioObjectPropertyAddress& address) {
    for (PropertyObserver* observer : observers_) {
        if (observer) {
            observer->onPropertyChanged(tapID_, address);
        }
    }
}

OSStatus AudioTap::propertyListenerCallback(
    AudioObjectID inObjectID,
    UInt32 inNumberAddresses,
    const AudioObjectPropertyAddress inAddresses[],
    void* inClientData)
{
    AudioTap* self = static_cast<AudioTap*>(inClientData);
    if (!self) {
        return noErr;
    }

    for (UInt32 i = 0; i < inNumberAddresses; ++i) {
        Logger::info("AudioTap: 配置变化通知");
        self->notifyObservers(inAddresses[i]);
    }

    return noErr;
}

} // namespace bitbook::business
