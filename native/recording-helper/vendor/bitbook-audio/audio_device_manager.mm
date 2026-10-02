// audio_device_manager.mm
// 音频设备管理器实现

#import "audio_device_manager.h"
#import <Foundation/Foundation.h>

namespace bitbook {

/**
 * 获取系统默认输入设备
 */
AudioObjectID AudioDeviceManager::getDefaultInputDevice() {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    AudioObjectID deviceID = kAudioObjectUnknown;
    UInt32 dataSize = sizeof(AudioObjectID);

    OSStatus err = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        &deviceID
    );

    if (err != noErr) {
        NSLog(@"❌ [DeviceManager] 获取默认输入设备失败: %d", err);
        return kAudioObjectUnknown;
    }

    if (deviceID == kAudioObjectUnknown) {
        NSLog(@"⚠️  [DeviceManager] 系统没有默认输入设备");
        return kAudioObjectUnknown;
    }

    // 获取设备名称用于日志
    std::string deviceName = getDeviceName(deviceID);
    std::string deviceUID = getDeviceUID(deviceID);

    NSLog(@"✅ [DeviceManager] 找到默认输入设备:");
    NSLog(@"   名称: %s", deviceName.c_str());
    NSLog(@"   UID: %s", deviceUID.c_str());
    NSLog(@"   ID: %u", deviceID);

    return deviceID;
}

/**
 * 获取系统默认输出设备
 */
AudioObjectID AudioDeviceManager::getDefaultOutputDevice() {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    AudioObjectID deviceID = kAudioObjectUnknown;
    UInt32 dataSize = sizeof(AudioObjectID);

    OSStatus err = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        &deviceID
    );

    if (err != noErr) {
        NSLog(@"❌ [DeviceManager] 获取默认输出设备失败: %d", err);
        return kAudioObjectUnknown;
    }

    if (deviceID == kAudioObjectUnknown) {
        NSLog(@"⚠️  [DeviceManager] 系统没有默认输出设备");
        return kAudioObjectUnknown;
    }

    std::string deviceName = getDeviceName(deviceID);
    std::string deviceUID = getDeviceUID(deviceID);

    NSLog(@"✅ [DeviceManager] 找到默认输出设备:");
    NSLog(@"   名称: %s", deviceName.c_str());
    NSLog(@"   UID: %s", deviceUID.c_str());
    NSLog(@"   ID: %u", deviceID);

    return deviceID;
}

/**
 * 获取设备 UID
 */
std::string AudioDeviceManager::getDeviceUID(AudioObjectID deviceID) {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    CFStringRef uidRef = NULL;
    UInt32 dataSize = sizeof(CFStringRef);

    OSStatus err = AudioObjectGetPropertyData(
        deviceID,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        &uidRef
    );

    if (err != noErr || !uidRef) {
        NSLog(@"⚠️  [DeviceManager] 无法获取设备 %u 的 UID: %d", deviceID, err);
        return "";
    }

    NSString *uidString = (__bridge NSString *)uidRef;
    std::string uid = [uidString UTF8String];

    CFRelease(uidRef);
    return uid;
}

/**
 * 获取设备名称
 */
std::string AudioDeviceManager::getDeviceName(AudioObjectID deviceID) {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    CFStringRef nameRef = NULL;
    UInt32 dataSize = sizeof(CFStringRef);

    OSStatus err = AudioObjectGetPropertyData(
        deviceID,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        &nameRef
    );

    if (err != noErr || !nameRef) {
        NSLog(@"⚠️  [DeviceManager] 无法获取设备 %u 的名称: %d", deviceID, err);
        return "Unknown";
    }

    NSString *nameString = (__bridge NSString *)nameRef;
    std::string name = [nameString UTF8String];

    CFRelease(nameRef);
    return name;
}

/**
 * 检查设备是否有输入流
 */
bool AudioDeviceManager::hasInputStream(AudioObjectID deviceID) {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioDevicePropertyStreams,
        kAudioDevicePropertyScopeInput,  // 输入流
        kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus err = AudioObjectGetPropertyDataSize(
        deviceID,
        &propertyAddress,
        0,
        NULL,
        &dataSize
    );

    return (err == noErr && dataSize > 0);
}

/**
 * 检查设备是否有输出流
 */
bool AudioDeviceManager::hasOutputStream(AudioObjectID deviceID) {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioDevicePropertyStreams,
        kAudioDevicePropertyScopeOutput,  // 输出流
        kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus err = AudioObjectGetPropertyDataSize(
        deviceID,
        &propertyAddress,
        0,
        NULL,
        &dataSize
    );

    return (err == noErr && dataSize > 0);
}

/**
 * 枚举所有音频设备
 */
std::vector<AudioDeviceInfo> AudioDeviceManager::enumerateDevices() {
    std::vector<AudioDeviceInfo> devices;

    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus err = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize
    );

    if (err != noErr) {
        NSLog(@"❌ [DeviceManager] 获取设备列表大小失败: %d", err);
        return devices;
    }

    int deviceCount = dataSize / sizeof(AudioObjectID);
    AudioObjectID *deviceIDs = new AudioObjectID[deviceCount];

    err = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        deviceIDs
    );

    if (err != noErr) {
        NSLog(@"❌ [DeviceManager] 获取设备列表失败: %d", err);
        delete[] deviceIDs;
        return devices;
    }

    NSLog(@"📊 [DeviceManager] 枚举系统音频设备:");

    for (int i = 0; i < deviceCount; i++) {
        AudioDeviceInfo info;
        info.deviceID = deviceIDs[i];
        info.uid = getDeviceUID(deviceIDs[i]);
        info.name = getDeviceName(deviceIDs[i]);
        info.isInput = hasInputStream(deviceIDs[i]);
        info.isOutput = hasOutputStream(deviceIDs[i]);

        devices.push_back(info);

        // 打印设备信息
        NSLog(@"   [%d] %s (ID: %u)",
              i,
              info.name.c_str(),
              info.deviceID);
        NSLog(@"       UID: %s", info.uid.c_str());
        NSLog(@"       输入: %s, 输出: %s",
              info.isInput ? "是" : "否",
              info.isOutput ? "是" : "否");
    }

    delete[] deviceIDs;

    NSLog(@"✅ [DeviceManager] 总计 %lu 个音频设备", devices.size());
    return devices;
}

} // namespace bitbook
