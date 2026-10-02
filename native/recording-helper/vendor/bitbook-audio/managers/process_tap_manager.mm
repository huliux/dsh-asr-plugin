#import "process_tap_manager.h"
#import "utils/logger.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <signal.h>

using namespace bitbook::business;
using namespace bitbook::utils;

/**
 * ProcessTapManager 实现（Phase 2 重构）
 *
 * 重构说明：
 * - 使用 AudioProcess 和 AudioTap 业务对象
 * - 职责变为协调层（不再直接管理进程和Tap状态）
 * - 保持向后兼容的公共接口
 *
 * 对应 Apple 官方示例：
 * - AudioTap.swift: setTapDescription()
 * - Model.swift: 管理业务对象生命周期
 */

// 前向声明静态辅助函数
static CATapDescription* CreateNativeTapDescription(const TapConfig& config, AudioObjectID processObjectID);

// 构造函数
ProcessTapManager::ProcessTapManager(const TapConfig& config, pid_t pid)
    : config_(config)
    , pid_(pid)
    , process_(nullptr)
    , tap_(nullptr)
    , tapID_(kAudioObjectUnknown)
    , lastError_("") {
}

// 析构函数（自动清理资源）
ProcessTapManager::~ProcessTapManager() {
    destroyTap();
}

// 创建 Process Tap（Phase 2 重构）
bool ProcessTapManager::createTap() {
    @autoreleasepool {
        if (@available(macOS 14.2, *)) {
            // Core Audio Process Tap is available.
        } else {
            setError("系统音频录制需要 macOS 14.2 或更高版本");
            Logger::error("ProcessTapManager: " + lastError_);
            return false;
        }
        Logger::info("ProcessTapManager: 开始创建 Process Tap");

        // 1. 验证配置
        if (!config_.isValid()) {
            setError("TapConfig 验证失败");
            Logger::error("ProcessTapManager: " + lastError_);
            return false;
        }

        // 2. 如果已经创建，先销毁
        if (isCreated()) {
            Logger::warning("ProcessTapManager: Tap 已存在，先销毁");
            destroyTap();
        }

        // ==================== Phase 4: 支持空 Tap（PID=0）====================
        AudioObjectID processObjectID = kAudioObjectUnknown;

        if (pid_ > 0) {
            // 有指定进程，创建 AudioProcess 对象
            Logger::infof("ProcessTapManager: 创建 AudioProcess 对象（PID=%d）", pid_);
            process_ = std::make_unique<AudioProcess>(pid_);

            if (process_->getProcessID() == kAudioObjectUnknown) {
                setError("无法找到目标进程的 CoreAudio ProcessID (PID=" + std::to_string(pid_) + ")");
                Logger::error("ProcessTapManager: " + lastError_);
                return false;
            }

            processObjectID = process_->getProcessID();
            Logger::infof("ProcessTapManager: 找到进程 '%s' (PID=%d, ProcessID=%u)",
                         process_->getProcessName().c_str(), pid_, processObjectID);
        } else {
            // PID=0: 创建空 Tap（不绑定进程）
            Logger::info("ProcessTapManager: PID=0，创建空 Tap（不绑定任何进程）");
            processObjectID = kAudioObjectUnknown;  // 空 Tap
        }

        // ==================== CoreAudio API: 创建 Process Tap ====================

        // 3. 创建 CATapDescription（支持空进程列表）
        CATapDescription *tapDesc = CreateNativeTapDescription(config_, processObjectID);

        if (!tapDesc) {
            setError("创建 CATapDescription 失败");
            Logger::error("ProcessTapManager: " + lastError_);
            return false;
        }

        Logger::info("ProcessTapManager: CATapDescription 创建成功");

        // 4. 调用 AudioHardwareCreateProcessTap
        OSStatus err = AudioHardwareCreateProcessTap(tapDesc, &tapID_);

        if (err != noErr) {
            setError("创建 Process Tap 失败: OSStatus " + std::to_string(err) +
                     "\n可能原因:\n" +
                     "  1. 进程未输出音频\n" +
                     "  2. 权限不足（需要 AudioCapture 权限）\n" +
                     "  3. 进程音频系统未就绪");
            Logger::error("ProcessTapManager: " + lastError_);
            return false;
        }

        Logger::infof("ProcessTapManager: AudioHardwareCreateProcessTap 成功（TapID=%u）", tapID_);

        // ==================== Phase 2 验证: 检查 Tap 是否在系统列表中 ====================
        AudioObjectPropertyAddress tapListAddr = {
            kAudioHardwarePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 tapListSize = 0;
        err = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &tapListAddr, 0, nil, &tapListSize);
        if (err == noErr && tapListSize > 0) {
            UInt32 tapCount = tapListSize / sizeof(AudioObjectID);
            std::vector<AudioObjectID> tapIDs(tapCount);
            err = AudioObjectGetPropertyData(kAudioObjectSystemObject, &tapListAddr, 0, nil, &tapListSize, tapIDs.data());

            if (err == noErr) {
                bool foundInList = false;
                for (AudioObjectID id : tapIDs) {
                    if (id == tapID_) {
                        foundInList = true;
                        break;
                    }
                }

                if (foundInList) {
                    Logger::infof("✅ ProcessTapManager: 新创建的 Tap (ID=%u) 已出现在系统列表中（共 %u 个 Tap）", tapID_, tapCount);
                } else {
                    Logger::warningf("⚠️ ProcessTapManager: 新创建的 Tap (ID=%u) 未出现在系统列表中（系统共 %u 个 Tap）", tapID_, tapCount);
                    Logger::info("ProcessTapManager: 这可能是 CoreAudio 的隔离机制（继续执行）");
                }
            }
        }
        // ==================== 结束验证 ====================

        // 5. 获取 Tap UUID
        AudioObjectPropertyAddress tapUIDAddr = {
            kAudioTapPropertyUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        CFStringRef tapUIDString = nil;
        UInt32 size = sizeof(tapUIDString);
        err = AudioObjectGetPropertyData(tapID_, &tapUIDAddr, 0, nil, &size, &tapUIDString);

        if (err != noErr || !tapUIDString) {
            setError("获取 Tap UID 失败: OSStatus " + std::to_string(err));
            Logger::error("ProcessTapManager: " + lastError_);
            // 清理 Tap
            AudioHardwareDestroyProcessTap(tapID_);
            tapID_ = kAudioObjectUnknown;
            return false;
        }

        // 6. 将 UID 字符串转换为 CFUUIDRef
        NSString *uidNSString = (__bridge NSString*)tapUIDString;
        NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:uidNSString];

        if (!uuid) {
            setError("无法解析 Tap UUID: " + std::string([uidNSString UTF8String]));
            Logger::error("ProcessTapManager: " + lastError_);
            CFRelease(tapUIDString);
            AudioHardwareDestroyProcessTap(tapID_);
            tapID_ = kAudioObjectUnknown;
            return false;
        }

        // 转换为 CFUUIDRef
        uuid_t uuidBytes;
        [uuid getUUIDBytes:uuidBytes];
        CFUUIDRef tapUUID = CFUUIDCreateFromUUIDBytes(kCFAllocatorDefault, *(CFUUIDBytes*)uuidBytes);

        CFRelease(tapUIDString);

        if (!tapUUID) {
            setError("创建 CFUUID 失败");
            Logger::error("ProcessTapManager: " + lastError_);
            AudioHardwareDestroyProcessTap(tapID_);
            tapID_ = kAudioObjectUnknown;
            return false;
        }

        Logger::infof("ProcessTapManager: Tap UUID 获取成功（%s）", [uidNSString UTF8String]);

        // ==================== Phase 2: 创建 AudioTap 对象 ====================
        Logger::info("ProcessTapManager: 创建 AudioTap 对象");
        tap_ = std::make_unique<AudioTap>(tapUUID);  // AudioTap 接管 UUID 的所有权

        if (tap_->getTapID() == kAudioObjectUnknown) {
            setError("无法找到创建的 Tap（AudioTap 初始化失败）");
            Logger::error("ProcessTapManager: " + lastError_);

            // 清理已创建的 Tap
            AudioHardwareDestroyProcessTap(tapID_);
            tapID_ = kAudioObjectUnknown;
            return false;
        }

        // ==================== 成功 ====================
        Logger::info("✅ ProcessTapManager: Process Tap 创建成功");

        // ✅ Phase 4: 条件输出进程信息（避免空指针解引用）
        if (process_) {
            // 有绑定进程时输出进程信息
            Logger::infof("   进程: %s (PID=%d, ProcessID=%u)",
                         process_->getProcessName().c_str(), pid_, process_->getProcessID());
        } else {
            // 空 Tap 时输出提示
            Logger::info("   进程: (空 Tap, PID=0)");
        }

        Logger::infof("   Tap: %s (TapID=%u)",
                     tap_->getUID().c_str(), tap_->getTapID());
        Logger::infof("   配置: name='%s', isPrivate=%d",
                     config_.name.c_str(), config_.isPrivate);

        return true;
    }
}

// 销毁 Process Tap
void ProcessTapManager::destroyTap() {
    @autoreleasepool {
        if (tapID_ != kAudioObjectUnknown) {
            Logger::infof("ProcessTapManager: 销毁 Process Tap (TapID=%u)", tapID_);

            // 调用 CoreAudio API 销毁 Tap
            OSStatus err = noErr;
            if (@available(macOS 14.2, *)) {
                err = AudioHardwareDestroyProcessTap(tapID_);
            } else {
                err = kAudioHardwareUnsupportedOperationError;
            }
            if (err != noErr) {
                Logger::warningf("ProcessTapManager: 销毁 Tap 失败，错误码=%d", err);
            } else {
                Logger::info("ProcessTapManager: Tap 已销毁");
            }

            tapID_ = kAudioObjectUnknown;
        }

        // 清理业务对象（RAII 自动释放）
        if (tap_) {
            Logger::info("ProcessTapManager: 释放 AudioTap 对象");
            tap_.reset();
        }

        if (process_) {
            Logger::info("ProcessTapManager: 释放 AudioProcess 对象");
            process_.reset();
        }
    }
}

// 验证 PID 有效性
bool ProcessTapManager::validatePID() const {
    if (pid_ <= 0) {
        return false;
    }

    // 使用 kill(pid, 0) 检查进程是否存在
    // signal 0 不会发送实际信号，只检查权限
    // 注意：沙箱环境下可能失败，实际验证在 AudioHardwareCreateProcessTap 中进行
    if (kill(pid_, 0) != 0) {
        return false;
    }

    return true;
}

// 静态辅助函数：根据配置创建 CATapDescription
// ✅ 参考 audiotee 项目：使用默认初始化 + 手动设置属性
static CATapDescription* CreateNativeTapDescription(const TapConfig& config, AudioObjectID processObjectID) {
    @autoreleasepool {
        // ✅ 关键修复：使用默认初始化（与 audiotee 一致）
        // audiotee: let description = CATapDescription()
        CATapDescription *tapDesc = [[CATapDescription alloc] init];

        if (!tapDesc) {
            Logger::error("ProcessTapManager: CATapDescription 初始化失败");
            return nil;
        }

        // ✅ 构建进程列表
        NSArray *processList = nil;

        if (!config.processes.empty()) {
            // 全局模式：使用配置中的所有进程
            NSMutableArray *tempList = [NSMutableArray arrayWithCapacity:config.processes.size()];
            for (AudioObjectID pid : config.processes) {
                [tempList addObject:@(pid)];
            }
            processList = tempList;
            Logger::infof("ProcessTapManager: 创建 Tap 绑定 %zu 个进程（全局模式）", config.processes.size());
        } else if (processObjectID != kAudioObjectUnknown) {
            // 单进程模式：使用传入的 processObjectID
            processList = @[@(processObjectID)];
            Logger::infof("ProcessTapManager: 创建 Tap 绑定单个进程 (ProcessID=%u)", processObjectID);
        } else {
            // ✅ 空 Tap：空进程列表 + isExclusive=true = 捕获所有系统音频
            // 参考 audiotee: return ([], true)  // Default: tap everything
            processList = @[];
            Logger::info("ProcessTapManager: 创建空 Tap（进程列表为空 + isExclusive=true = 捕获所有音频）");
        }

        // ✅ 设置属性（与 audiotee 一致）
        // 注意：Objective-C 属性名称与 Swift 不同
        // Swift: isPrivate, isMixdown, isMono
        // ObjC:  privateTap (setPrivate:), mixdown, mono

        // 1. name
        tapDesc.name = [NSString stringWithUTF8String:config.name.c_str()];

        // 2. processes
        tapDesc.processes = processList;

        // 3. privateTap (对应 Swift 的 isPrivate)
        [tapDesc setPrivate:config.isPrivate ? YES : NO];

        // 4. muteBehavior
        switch (config.muteBehavior) {
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

        // 5. mixdown / mono（根据 mixdownMode 设置）
        switch (config.mixdownMode) {
            case TapConfig::MixdownMode::Mono:
                tapDesc.mixdown = YES;
                tapDesc.mono = YES;
                Logger::info("ProcessTapManager: 使用 Mono 混音模式");
                break;
            case TapConfig::MixdownMode::Stereo:
                tapDesc.mixdown = YES;
                tapDesc.mono = NO;
                Logger::info("ProcessTapManager: 使用 Stereo 混音模式");
                break;
            case TapConfig::MixdownMode::DeviceFormat:
                tapDesc.mixdown = NO;
                tapDesc.mono = NO;
                Logger::info("ProcessTapManager: 使用 DeviceFormat 模式");
                break;
        }

        // 7. exclusive（关键！）
        // 参考 audiotee：空进程列表 + isExclusive=true = 捕获所有进程音频
        tapDesc.exclusive = config.isExclusive ? YES : NO;
        Logger::infof("ProcessTapManager: isExclusive=%s", config.isExclusive ? "YES" : "NO");

        // 8. deviceUID / stream
        if (config.mixdownMode == TapConfig::MixdownMode::DeviceFormat &&
            config.deviceUID.has_value() &&
            !config.deviceUID->empty()) {
            tapDesc.deviceUID = [NSString stringWithUTF8String:config.deviceUID->c_str()];
            tapDesc.stream = @(config.streamIndex);
            Logger::infof(
                "ProcessTapManager: 绑定目标输出设备 UID=%s, stream=%u",
                config.deviceUID->c_str(),
                static_cast<unsigned int>(config.streamIndex)
            );
        } else {
            tapDesc.deviceUID = nil;
            tapDesc.stream = @0;
        }

        // 10. UUID（生成新的）
        tapDesc.UUID = [NSUUID UUID];

        Logger::infof("ProcessTapManager: CATapDescription 配置完成（name='%s', processes=%lu, mixdown=%s, mono=%s, exclusive=%s）",
                     config.name.c_str(),
                     (unsigned long)[processList count],
                     tapDesc.mixdown ? "YES" : "NO",
                     tapDesc.mono ? "YES" : "NO",
                     tapDesc.exclusive ? "YES" : "NO");

        return tapDesc;
    }
}
