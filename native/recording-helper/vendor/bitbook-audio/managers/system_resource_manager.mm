#import "system_resource_manager.h"
#import "utils/logger.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <vector>
#import <algorithm>

using namespace bitbook::business;
using namespace bitbook::utils;

namespace bitbook {

// ==================== 加载系统进程列表 ====================

std::vector<std::shared_ptr<AudioProcess>> SystemResourceManager::loadProcessList() {
    @autoreleasepool {
        std::vector<std::shared_ptr<AudioProcess>> processes;

        Logger::info("SystemResourceManager: 开始枚举系统音频进程...");

        // 1. 查询系统进程列表
        AudioObjectPropertyAddress processListAddr = {
            kAudioHardwarePropertyProcessObjectList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &processListAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warningf("SystemResourceManager: 无法获取进程列表，错误码=%d", err);
            return processes;
        }

        UInt32 numProcesses = dataSize / sizeof(AudioObjectID);
        std::vector<AudioObjectID> processIDs(numProcesses);

        err = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &processListAddr, 0, nullptr,
            &dataSize, processIDs.data()
        );

        if (err != noErr) {
            Logger::errorf("SystemResourceManager: 获取进程列表失败，错误码=%d", err);
            return processes;
        }

        // Logger::infof("SystemResourceManager: 找到 %u 个 ProcessID", numProcesses);

        // 2. 为每个 ProcessID 创建 AudioProcess 对象
        for (AudioObjectID processID : processIDs) {
            // 查询 PID
            pid_t pid = 0;
            UInt32 pidSize = sizeof(pid_t);

            AudioObjectPropertyAddress pidAddr = {
                kAudioProcessPropertyPID,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };

            err = AudioObjectGetPropertyData(
                processID, &pidAddr, 0, nullptr, &pidSize, &pid
            );

            if (err == noErr && pid > 0) {
                try {
                    auto process = std::make_shared<AudioProcess>(pid);
                    if (process->getProcessID() != kAudioObjectUnknown) {
                        processes.push_back(process);
                        // Logger::infof("SystemResourceManager: 添加进程 %s (PID=%d)",
                        //              process->getProcessName().c_str(), pid);
                    }
                } catch (const std::exception& e) {
                    Logger::warningf("SystemResourceManager: 创建 AudioProcess 失败 (PID=%d): %s",
                                    pid, e.what());
                }
            }
        }

        // 3. 按 PID 排序
        std::sort(processes.begin(), processes.end(),
                  [](const std::shared_ptr<AudioProcess>& a, const std::shared_ptr<AudioProcess>& b) {
                      return a->getPID() < b->getPID();
                  });

        Logger::infof("SystemResourceManager: 加载了 %zu 个音频进程", processes.size());
        return processes;
    }
}

// ==================== 加载系统 Tap 列表 ====================

std::vector<std::shared_ptr<AudioTap>> SystemResourceManager::loadTapList() {
    @autoreleasepool {
        std::vector<std::shared_ptr<AudioTap>> taps;

        Logger::info("SystemResourceManager: 开始枚举系统 Tap...");

        // 1. 查询系统 Tap 列表
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
            Logger::info("SystemResourceManager: 系统中没有 Tap");
            return taps;
        }

        UInt32 numTaps = dataSize / sizeof(AudioObjectID);
        std::vector<AudioObjectID> tapIDs(numTaps);

        err = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &tapListAddr, 0, nullptr,
            &dataSize, tapIDs.data()
        );

        if (err != noErr) {
            Logger::errorf("SystemResourceManager: 获取 Tap 列表失败，错误码=%d", err);
            return taps;
        }

        Logger::infof("SystemResourceManager: 找到 %u 个 TapID", numTaps);

        // 2. 为每个 TapID 创建 AudioTap 对象
        for (AudioObjectID tapID : tapIDs) {
            // 查询 Tap UID
            CFStringRef tapUIDString = nullptr;
            UInt32 uidSize = sizeof(CFStringRef);

            AudioObjectPropertyAddress uidAddr = {
                kAudioTapPropertyUID,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };

            err = AudioObjectGetPropertyData(
                tapID, &uidAddr, 0, nullptr, &uidSize, &tapUIDString
            );

            if (err == noErr && tapUIDString) {
                // 转换 UID 字符串为 CFUUIDRef
                CFUUIDRef uuid = CFUUIDCreateFromString(kCFAllocatorDefault, tapUIDString);
                NSString *uidNSString = (__bridge NSString*)tapUIDString;
                CFRelease(tapUIDString);

                if (uuid) {
                    try {
                        auto tap = std::make_shared<AudioTap>(uuid);
                        if (tap->getTapID() != kAudioObjectUnknown) {
                            taps.push_back(tap);
                            Logger::infof("SystemResourceManager: 添加 Tap %s",
                                         [uidNSString UTF8String]);
                        }
                        // uuid 的所有权已转移给 AudioTap
                    } catch (const std::exception& e) {
                        Logger::warningf("SystemResourceManager: 创建 AudioTap 失败: %s",
                                        e.what());
                        CFRelease(uuid);
                    }
                }
            }
        }

        Logger::infof("SystemResourceManager: 加载了 %zu 个 Tap", taps.size());
        return taps;
    }
}

// ==================== 加载系统设备列表 ====================

std::vector<SystemResourceManager::DeviceInfo> SystemResourceManager::loadDeviceList() {
    @autoreleasepool {
        std::vector<DeviceInfo> devices;

        Logger::info("SystemResourceManager: 开始枚举系统音频设备...");

        // 1. 查询系统设备列表
        AudioObjectPropertyAddress deviceListAddr = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &deviceListAddr, 0, nullptr, &dataSize
        );

        if (err != noErr || dataSize == 0) {
            Logger::warningf("SystemResourceManager: 无法获取设备列表，错误码=%d", err);
            return devices;
        }

        UInt32 numDevices = dataSize / sizeof(AudioObjectID);
        std::vector<AudioObjectID> deviceIDs(numDevices);

        err = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &deviceListAddr, 0, nullptr,
            &dataSize, deviceIDs.data()
        );

        if (err != noErr) {
            Logger::errorf("SystemResourceManager: 获取设备列表失败，错误码=%d", err);
            return devices;
        }

        Logger::infof("SystemResourceManager: 找到 %u 个设备", numDevices);

        // 2. 为每个设备查询信息
        for (AudioObjectID deviceID : deviceIDs) {
            DeviceInfo info;
            info.deviceID = deviceID;
            info.uid = getDeviceUID(deviceID);
            info.name = getDeviceName(deviceID);
            queryDeviceCapabilities(deviceID, info.hasInput, info.hasOutput);

            devices.push_back(info);
            Logger::infof("SystemResourceManager: 添加设备 %s (Input=%d, Output=%d)",
                         info.name.c_str(), info.hasInput, info.hasOutput);
        }

        Logger::infof("SystemResourceManager: 加载了 %zu 个设备", devices.size());
        return devices;
    }
}

// ==================== 查找方法 ====================

std::shared_ptr<AudioProcess> SystemResourceManager::findProcessByPID(pid_t pid) {
    auto processes = loadProcessList();
    for (const auto& process : processes) {
        if (process->getPID() == pid) {
            return process;
        }
    }
    return nullptr;
}

std::shared_ptr<AudioTap> SystemResourceManager::findTapByUID(const std::string& uid) {
    auto taps = loadTapList();
    for (const auto& tap : taps) {
        if (tap->getUID() == uid) {
            return tap;
        }
    }
    return nullptr;
}

SystemResourceManager::DeviceInfo SystemResourceManager::findDeviceByUID(const std::string& uid) {
    auto devices = loadDeviceList();
    for (const auto& device : devices) {
        if (device.uid == uid) {
            return device;
        }
    }
    return DeviceInfo();
}

// ==================== 私有辅助方法 ====================

void SystemResourceManager::queryDeviceCapabilities(AudioObjectID deviceID, bool& hasInput, bool& hasOutput) {
    @autoreleasepool {
        hasInput = false;
        hasOutput = false;

        // 查询输入流
        AudioObjectPropertyAddress inputStreamsAddr = {
            kAudioDevicePropertyStreams,
            kAudioDevicePropertyScopeInput,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus err = AudioObjectGetPropertyDataSize(
            deviceID, &inputStreamsAddr, 0, nullptr, &dataSize
        );

        if (err == noErr && dataSize > 0) {
            hasInput = true;
        }

        // 查询输出流
        AudioObjectPropertyAddress outputStreamsAddr = {
            kAudioDevicePropertyStreams,
            kAudioDevicePropertyScopeOutput,
            kAudioObjectPropertyElementMain
        };

        err = AudioObjectGetPropertyDataSize(
            deviceID, &outputStreamsAddr, 0, nullptr, &dataSize
        );

        if (err == noErr && dataSize > 0) {
            hasOutput = true;
        }
    }
}

std::string SystemResourceManager::getDeviceName(AudioObjectID deviceID) {
    @autoreleasepool {
        AudioObjectPropertyAddress nameAddr = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        CFStringRef name = nullptr;
        UInt32 dataSize = sizeof(name);

        OSStatus err = AudioObjectGetPropertyData(
            deviceID, &nameAddr, 0, nullptr, &dataSize, &name
        );

        if (err == noErr && name) {
            NSString *nsName = (__bridge_transfer NSString*)name;
            return std::string([nsName UTF8String]);
        }

        return "Unknown";
    }
}

std::string SystemResourceManager::getDeviceUID(AudioObjectID deviceID) {
    @autoreleasepool {
        AudioObjectPropertyAddress uidAddr = {
            kAudioDevicePropertyDeviceUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        CFStringRef uid = nullptr;
        UInt32 dataSize = sizeof(uid);

        OSStatus err = AudioObjectGetPropertyData(
            deviceID, &uidAddr, 0, nullptr, &dataSize, &uid
        );

        if (err == noErr && uid) {
            NSString *nsUID = (__bridge_transfer NSString*)uid;
            return std::string([nsUID UTF8String]);
        }

        return "";
    }
}

} // namespace bitbook
