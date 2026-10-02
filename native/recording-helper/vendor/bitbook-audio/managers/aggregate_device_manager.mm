#import "aggregate_device_manager.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <iostream>
#import "../utils/logger.h"

using namespace bitbook::utils;

/**
 * AggregateDeviceManager 实现
 *
 * 对应 Apple 官方示例：
 * - AggregateDevice.swift: class AggregateDevice
 * - AggregateDeviceView.swift: addSubTap() - 动态添加 Tap
 */

// 构造函数
AggregateDeviceManager::AggregateDeviceManager(const AggregateDeviceConfig& config)
    : config_(config)
    , deviceID_(kAudioObjectUnknown)
    , deviceUID_("")
    , lastError_("")
    , listenersSetup_(false) {
}

// 析构函数（自动清理资源）
AggregateDeviceManager::~AggregateDeviceManager() {
    removePropertyListeners();
    destroyDevice();
}

// 创建 Aggregate Device
bool AggregateDeviceManager::createDevice(const std::vector<std::string>& microphoneUIDs) {
    @autoreleasepool {
        // 1. 验证配置
        if (!config_.isValid()) {
            setError("AggregateDeviceConfig 验证失败");
            return false;
        }

        // 2. 如果已经创建，先销毁
        if (isCreated()) {
            destroyDevice();
        }

        // 3. 生成唯一设备 UID
        NSUUID *uuid = [NSUUID UUID];
        NSString *deviceUIDNS = [uuid UUIDString];
        deviceUID_ = std::string([deviceUIDNS UTF8String]);

        // 4. 创建配置字典
        // ✅ 关键修复：参考 audiotee 项目，显式设置空的 SubDeviceList
        // 这样 Aggregate Device 可以只包含 Tap，不需要麦克风
        NSMutableDictionary *aggregateConfig = [NSMutableDictionary dictionaryWithDictionary:@{
            @kAudioAggregateDeviceNameKey: [NSString stringWithUTF8String:config_.name.c_str()],
            @kAudioAggregateDeviceUIDKey: deviceUIDNS,
            @kAudioAggregateDeviceSubDeviceListKey: @[],  // ✅ 显式设置空数组（参考 audiotee）
            @kAudioAggregateDeviceMasterSubDeviceKey: @0, // ✅ 设置为 0（参考 audiotee）
            @kAudioAggregateDeviceIsPrivateKey: config_.isPrivate ? @YES : @NO,
            @kAudioAggregateDeviceIsStackedKey: @NO       // ✅ 设置为 NO（参考 audiotee）
        }];

        // 注意：SubDeviceList 初始为空，后续可以使用 addMicrophone() 动态添加
        // Tap 通过 addTap() 动态添加到 TapList

        using namespace bitbook::utils;
        Logger::info("✅ AggregateDeviceManager: 创建 Aggregate Device（空配置 - 对标 Apple）");
        Logger::infof("   设备名称: %s", config_.name.c_str());
        Logger::infof("   设备 UID: %s", [deviceUIDNS UTF8String]);
        Logger::infof("   IsPrivate: %s", config_.isPrivate ? "YES" : "NO");
        // Logger::infof("   TapAutoStart: %s", config_.tapAutoStart ? "YES" : "NO");  // ✅ 不再设置此参数

        // 6. 调用 AudioHardwareCreateAggregateDevice
        OSStatus err = AudioHardwareCreateAggregateDevice(
            (__bridge CFDictionaryRef)aggregateConfig,
            &deviceID_
        );

        if (err == 1852797029) {  // "nope" - 设备已存在
            setError("Aggregate Device 已存在（错误码：'nope'）");
            Logger::warning("⚠️ AggregateDeviceManager: 设备已存在");
            return false;
        } else if (err != noErr) {
            setError("创建 Aggregate Device 失败: OSStatus " + std::to_string(err));
            Logger::errorf("❌ AggregateDeviceManager: 创建失败: %d", err);
            return false;
        }

        // 7. 成功
        Logger::infof("✅ AggregateDeviceManager: Device 创建成功 (ID: %u)", deviceID_);

        // 8. 如果添加了麦克风，等待系统初始化
        if (!microphoneUIDs.empty()) {
            waitForSystemInitialization();
        }

        return true;
    }
}

// 动态添加 Process Tap
bool AggregateDeviceManager::addTap(CFUUIDRef tapUUID) {
    @autoreleasepool {
        // 1. 验证设备已创建
        if (!isCreated()) {
            setError("设备未创建，无法添加 Tap");
            return false;
        }

        // 2. 验证 Tap UUID 有效性
        if (!tapUUID) {
            setError("Tap UUID 无效（nullptr）");
            return false;
        }

        using namespace bitbook::utils;
        Logger::info("🔄 AggregateDeviceManager: 动态添加 Tap（对应 Apple addSubTap）");

        // 3. 将 CFUUIDRef 转换为 CFStringRef
        CFStringRef tapUIDString = CFUUIDCreateString(kCFAllocatorDefault, tapUUID);
        if (!tapUIDString) {
            setError("无法将 Tap UUID 转换为字符串");
            return false;
        }

        Logger::infof("   Tap UUID: %s", [(__bridge NSString*)tapUIDString UTF8String]);

        // 4. 准备 TapList 属性地址
        AudioObjectPropertyAddress tapListAddr = {
            kAudioAggregateDevicePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        // 5. 读取当前 TapList（可能为空）
        UInt32 currentTapListSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(deviceID_, &tapListAddr, 0, nil, &currentTapListSize);

        Logger::infof("   当前 TapList 大小: %u bytes", currentTapListSize);

        // 6. 创建新的 TapList（追加新 Tap）
        NSMutableArray *tapArray = [NSMutableArray array];

        // 如果当前有 Tap，先读取
        if (err == noErr && currentTapListSize > 0) {
            CFArrayRef currentTapList = nil;
            err = AudioObjectGetPropertyData(deviceID_, &tapListAddr, 0, nil, &currentTapListSize, &currentTapList);
            if (err == noErr && currentTapList) {
                [tapArray addObjectsFromArray:(__bridge NSArray*)currentTapList];
                CFRelease(currentTapList);
            }
        }

        // 添加新的 Tap UID
        [tapArray addObject:(__bridge NSString*)tapUIDString];

        Logger::infof("   新 TapList 包含 %lu 个 Tap", (unsigned long)tapArray.count);

        // 7. 使用 AudioObjectSetPropertyData 设置 TapList
        // 这是 Apple UI "勾选 Tap" 的实现方式
        CFArrayRef tapListRef = (__bridge CFArrayRef)tapArray;
        UInt32 newTapListSize = (UInt32)(tapArray.count * sizeof(CFStringRef));

        err = AudioObjectSetPropertyData(
            deviceID_,
            &tapListAddr,
            0, nil,
            newTapListSize,
            &tapListRef
        );

        CFRelease(tapUIDString);

        if (err != noErr) {
            setError("动态添加 Tap 失败: OSStatus " + std::to_string(err));
            Logger::errorf("❌ AggregateDeviceManager: 添加 Tap 失败: %d", err);
            return false;
        }

        Logger::info("✅ AggregateDeviceManager: Tap 已动态添加");

        // 8. 等待系统初始化（200ms）
        waitForSystemInitialization();

        return true;
    }
}

// 销毁 Aggregate Device
void AggregateDeviceManager::destroyDevice() {
    if (isCreated()) {
        using namespace bitbook::utils;
        OSStatus err = AudioHardwareDestroyAggregateDevice(deviceID_);
        if (err != noErr) {
            Logger::warningf("⚠️ AggregateDeviceManager: 销毁设备失败: %d", err);
        } else {
            Logger::infof("✅ AggregateDeviceManager: Device 已销毁 (ID: %u)", deviceID_);
        }
        deviceID_ = kAudioObjectUnknown;
        deviceUID_ = "";
    }
}

// 动态添加麦克风设备（对应 Apple 示例的 addSubDevice）
bool AggregateDeviceManager::addMicrophone(const std::string& deviceUID) {
    @autoreleasepool {
        // 1. 验证设备已创建
        if (!isCreated()) {
            setError("设备未创建，无法添加麦克风");
            return false;
        }

        // 2. 验证设备 UID 有效性
        if (deviceUID.empty()) {
            setError("设备 UID 为空");
            return false;
        }

        using namespace bitbook::utils;
        Logger::info("🔄 AggregateDeviceManager: 动态添加麦克风（对应 Apple addSubDevice）");
        Logger::infof("   设备 UID: %s", deviceUID.c_str());

        // 3. 准备 FullSubDeviceList 属性地址（关键：使用 Full 版本！）
        AudioObjectPropertyAddress deviceListAddr = {
            kAudioAggregateDevicePropertyFullSubDeviceList,  // 注意：使用 Full 版本！
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        // 4. 读取当前设备列表
        UInt32 currentListSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(deviceID_, &deviceListAddr, 0, nil, &currentListSize);

        Logger::infof("   当前 SubDeviceList 大小: %u bytes", currentListSize);

        // 5. 创建新的设备列表（追加新设备）
        NSMutableArray *deviceArray = [NSMutableArray array];

        // 如果当前有设备，先读取
        if (err == noErr && currentListSize > 0) {
            CFArrayRef currentDeviceList = nil;
            err = AudioObjectGetPropertyData(deviceID_, &deviceListAddr, 0, nil, &currentListSize, &currentDeviceList);
            if (err == noErr && currentDeviceList) {
                [deviceArray addObjectsFromArray:(__bridge NSArray*)currentDeviceList];
                CFRelease(currentDeviceList);
            }
        }

        // 添加新的设备 UID
        [deviceArray addObject:[NSString stringWithUTF8String:deviceUID.c_str()]];

        Logger::infof("   新 SubDeviceList 包含 %lu 个设备", (unsigned long)deviceArray.count);

        // 6. 使用 AudioObjectSetPropertyData 设置设备列表
        CFArrayRef deviceListRef = (__bridge CFArrayRef)deviceArray;
        UInt32 newListSize = (UInt32)(deviceArray.count * sizeof(CFStringRef));

        err = AudioObjectSetPropertyData(
            deviceID_,
            &deviceListAddr,
            0, nil,
            newListSize,
            &deviceListRef
        );

        if (err != noErr) {
            setError("动态添加麦克风失败: OSStatus " + std::to_string(err));
            Logger::errorf("❌ AggregateDeviceManager: 添加麦克风失败: %d", err);
            return false;
        }

        Logger::info("✅ AggregateDeviceManager: 麦克风已动态添加");

        // 7. 等待系统初始化
        waitForSystemInitialization();

        return true;
    }
}

// ==================== 查询方法（Phase 2 新增）====================

// 获取子设备 UID 列表
std::vector<std::string> AggregateDeviceManager::getSubDeviceList() const {
    @autoreleasepool {
        if (!isCreated()) {
            return {};
        }

        AudioObjectPropertyAddress deviceListAddr = {
            kAudioAggregateDevicePropertyFullSubDeviceList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID_, &deviceListAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warning("AggregateDeviceManager: 无法获取子设备列表大小");
            return {};
        }

        CFArrayRef deviceListRef = nullptr;
        err = AudioObjectGetPropertyData(
            deviceID_, &deviceListAddr, 0, nullptr, &dataSize, &deviceListRef
        );

        if (err != noErr || !deviceListRef) {
            Logger::warningf("AggregateDeviceManager: 获取子设备列表失败，错误码=%d", err);
            return {};
        }

        NSArray *deviceArray = (__bridge_transfer NSArray*)deviceListRef;
        std::vector<std::string> result;

        for (NSString *uid in deviceArray) {
            result.push_back([uid UTF8String]);
        }

        Logger::infof("AggregateDeviceManager: 子设备列表查询成功（%zu 个）", result.size());
        return result;
    }
}

// 获取子 Tap UID 列表
std::vector<std::string> AggregateDeviceManager::getTapList() const {
    @autoreleasepool {
        if (!isCreated()) {
            return {};
        }

        AudioObjectPropertyAddress tapListAddr = {
            kAudioAggregateDevicePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID_, &tapListAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::info("AggregateDeviceManager: 无 Tap 或无法获取 Tap 列表大小");
            return {};
        }

        CFArrayRef tapListRef = nullptr;
        err = AudioObjectGetPropertyData(
            deviceID_, &tapListAddr, 0, nullptr, &dataSize, &tapListRef
        );

        if (err != noErr || !tapListRef) {
            Logger::warningf("AggregateDeviceManager: 获取 Tap 列表失败，错误码=%d", err);
            return {};
        }

        NSArray *tapArray = (__bridge_transfer NSArray*)tapListRef;
        std::vector<std::string> result;

        for (NSString *uid in tapArray) {
            result.push_back([uid UTF8String]);
        }

        Logger::infof("AggregateDeviceManager: Tap 列表查询成功（%zu 个）", result.size());
        return result;
    }
}

// 获取 autoStop 配置
bool AggregateDeviceManager::getAutoStop() const {
    @autoreleasepool {
        if (!isCreated()) {
            return false;
        }

        AudioObjectPropertyAddress compositionAddr = {
            kAudioAggregateDevicePropertyComposition,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warning("AggregateDeviceManager: 无法获取 Composition 配置大小");
            return false;
        }

        CFDictionaryRef compositionRef = nullptr;
        err = AudioObjectGetPropertyData(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize, &compositionRef
        );

        if (err != noErr || !compositionRef) {
            Logger::warningf("AggregateDeviceManager: 获取 Composition 配置失败，错误码=%d", err);
            return false;
        }

        NSDictionary *composition = (__bridge_transfer NSDictionary*)compositionRef;
        NSNumber *autoStop = composition[@"autoStop"];

        bool result = autoStop ? [autoStop boolValue] : false;
        Logger::infof("AggregateDeviceManager: autoStop=%d", result);
        return result;
    }
}

// 获取 isPrivate 配置
bool AggregateDeviceManager::getIsPrivate() const {
    @autoreleasepool {
        if (!isCreated()) {
            return false;
        }

        // isPrivate 从 Composition 字典中读取
        AudioObjectPropertyAddress compositionAddr = {
            kAudioAggregateDevicePropertyComposition,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warning("AggregateDeviceManager: 无法获取 Composition 配置大小");
            return false;
        }

        CFDictionaryRef compositionRef = nullptr;
        err = AudioObjectGetPropertyData(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize, &compositionRef
        );

        if (err != noErr || !compositionRef) {
            Logger::warningf("AggregateDeviceManager: 获取 Composition 配置失败，错误码=%d", err);
            return false;
        }

        NSDictionary *composition = (__bridge_transfer NSDictionary*)compositionRef;
        NSNumber *isPrivate = composition[@"private"];

        bool result = isPrivate ? [isPrivate boolValue] : false;
        Logger::infof("AggregateDeviceManager: isPrivate=%d", result);
        return result;
    }
}

// 获取 tapAutoStart 配置
bool AggregateDeviceManager::getTapAutoStart() const {
    @autoreleasepool {
        if (!isCreated()) {
            return false;
        }

        AudioObjectPropertyAddress compositionAddr = {
            kAudioAggregateDevicePropertyComposition,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warning("AggregateDeviceManager: 无法获取 Composition 配置大小");
            return false;
        }

        CFDictionaryRef compositionRef = nullptr;
        err = AudioObjectGetPropertyData(
            deviceID_, &compositionAddr, 0, nullptr, &dataSize, &compositionRef
        );

        if (err != noErr || !compositionRef) {
            Logger::warningf("AggregateDeviceManager: 获取 Composition 配置失败，错误码=%d", err);
            return false;
        }

        NSDictionary *composition = (__bridge_transfer NSDictionary*)compositionRef;
        NSNumber *tapAutoStart = composition[@"tapAutoStart"];

        bool result = tapAutoStart ? [tapAutoStart boolValue] : false;
        Logger::infof("AggregateDeviceManager: tapAutoStart=%d", result);
        return result;
    }
}

// 等待系统初始化（1000ms）
void AggregateDeviceManager::waitForSystemInitialization() const {
    using namespace bitbook::utils;
    Logger::info("⏳ AggregateDeviceManager: 等待系统初始化（1000ms）...");
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, false);
}

// ==================== 属性监听功能实现（Phase 3）====================

// CoreAudio 属性监听回调（静态方法）
OSStatus AggregateDeviceManager::propertyListenerProc(AudioObjectID inObjectID,
                                                       UInt32 inNumberAddresses,
                                                       const AudioObjectPropertyAddress inAddresses[],
                                                       void* inClientData) {
    AggregateDeviceManager* manager = static_cast<AggregateDeviceManager*>(inClientData);
    if (!manager) {
        return noErr;
    }

    // 遍历所有变化的属性，通知观察者
    for (UInt32 i = 0; i < inNumberAddresses; ++i) {
        manager->notifyObservers(inAddresses[i]);
    }

    return noErr;
}

// 通知所有观察者
void AggregateDeviceManager::notifyObservers(const AudioObjectPropertyAddress& address) {
    using namespace bitbook::business;

    // 日志记录属性变化
    const char* propertyName = "Unknown";
    if (address.mSelector == kAudioAggregateDevicePropertyFullSubDeviceList) {
        propertyName = "FullSubDeviceList";
    } else if (address.mSelector == kAudioAggregateDevicePropertyTapList) {
        propertyName = "TapList";
    } else if (address.mSelector == kAudioAggregateDevicePropertyComposition) {
        propertyName = "Composition";
    }

    Logger::infof("🔔 AggregateDeviceManager: 属性变化 - %s", propertyName);

    // 通知所有观察者
    for (auto observer : observers_) {
        if (observer) {
            observer->onPropertyChanged(deviceID_, address);
        }
    }
}

// 设置属性监听
bool AggregateDeviceManager::setupPropertyListeners() {
    if (!isCreated()) {
        setError("设备未创建，无法设置属性监听");
        Logger::error(lastError_);
        return false;
    }

    if (listenersSetup_) {
        Logger::info("AggregateDeviceManager: 属性监听已设置，跳过");
        return true;
    }

    Logger::info("🎧 AggregateDeviceManager: 设置属性监听");

    // 3 个需要监听的属性（对标 Apple 官方示例）
    AudioObjectPropertyAddress addresses[3] = {
        {
            kAudioAggregateDevicePropertyFullSubDeviceList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioAggregateDevicePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioAggregateDevicePropertyComposition,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        }
    };

    // 注册监听
    for (int i = 0; i < 3; ++i) {
        OSStatus err = AudioObjectAddPropertyListener(
            deviceID_,
            &addresses[i],
            propertyListenerProc,
            this
        );

        if (err != noErr) {
            setError("添加属性监听失败，错误码: " + std::to_string(err));
            Logger::errorf("AggregateDeviceManager: 添加属性监听失败 (selector=%u, err=%d)",
                          addresses[i].mSelector, err);
            // 清理已添加的监听
            for (int j = 0; j < i; ++j) {
                AudioObjectRemovePropertyListener(deviceID_, &addresses[j], propertyListenerProc, this);
            }
            return false;
        }

        Logger::infof("   已添加监听: selector=%u", addresses[i].mSelector);
    }

    listenersSetup_ = true;
    Logger::info("✅ AggregateDeviceManager: 属性监听设置成功");
    return true;
}

// 移除属性监听
void AggregateDeviceManager::removePropertyListeners() {
    if (!listenersSetup_ || !isCreated()) {
        return;
    }

    Logger::info("🔇 AggregateDeviceManager: 移除属性监听");

    AudioObjectPropertyAddress addresses[3] = {
        {
            kAudioAggregateDevicePropertyFullSubDeviceList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioAggregateDevicePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        },
        {
            kAudioAggregateDevicePropertyComposition,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        }
    };

    for (int i = 0; i < 3; ++i) {
        AudioObjectRemovePropertyListener(
            deviceID_,
            &addresses[i],
            propertyListenerProc,
            this
        );
    }

    listenersSetup_ = false;
    Logger::info("✅ AggregateDeviceManager: 属性监听已移除");
}

// 注册属性观察者
void AggregateDeviceManager::addPropertyObserver(bitbook::business::PropertyObserver* observer) {
    if (observer) {
        observers_.insert(observer);
        Logger::infof("AggregateDeviceManager: 注册观察者 (总数: %zu)", observers_.size());
    }
}

// 移除属性观察者
void AggregateDeviceManager::removePropertyObserver(bitbook::business::PropertyObserver* observer) {
    if (observer) {
        observers_.erase(observer);
        Logger::infof("AggregateDeviceManager: 移除观察者 (剩余: %zu)", observers_.size());
    }
}
