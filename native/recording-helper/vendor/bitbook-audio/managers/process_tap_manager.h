#ifndef PROCESS_TAP_MANAGER_H
#define PROCESS_TAP_MANAGER_H

#include "business/audio_process.h"
#include "business/audio_tap.h"
#include "config/tap_config.h"
#include <CoreAudio/CoreAudio.h>
#include <string>
#include <memory>
#include <sys/types.h>

/**
 * Process Tap 协调器
 *
 * Phase 2 重构说明:
 * - 职责调整：从"管理 Tap"变为"协调 Process 和 Tap 的创建"
 * - 使用业务对象：AudioProcess + AudioTap
 * - 符合单一职责原则
 *
 * 对应 Apple 官方示例：
 * - AudioTap.swift: setTapDescription(), updateTapConfig()
 * - Model.swift: 管理 AudioProcess 和 AudioTap 生命周期
 *
 * 核心功能：
 * - 为指定进程创建 Process Tap
 * - 管理 AudioProcess 和 AudioTap 的生命周期
 * - 提供统一的访问接口
 * - RAII 自动资源清理
 * - 详细的错误报告
 *
 * 使用示例：
 * ```cpp
 * TapConfig config;
 * config.name = "My Tap";
 * config.muteBehavior = TapConfig::MuteBehavior::Unmuted;
 *
 * ProcessTapManager manager(config, pid);
 * if (manager.createTap()) {
 *     // 获取业务对象（非拥有指针）
 *     AudioProcess* process = manager.getProcess();
 *     AudioTap* tap = manager.getTap();
 *
 *     // 使用业务对象
 *     std::cout << "Process: " << process->getProcessName() << std::endl;
 *     std::cout << "Tap: " << tap->getUID() << std::endl;
 *
 *     // 便捷方法（兼容旧接口）
 *     CFUUIDRef tapUUID = manager.getTapUUID();
 * } else {
 *     std::cerr << manager.getLastError() << std::endl;
 * }
 * // 析构时自动清理
 * ```
 */
class ProcessTapManager {
public:
    /**
     * 构造函数
     *
     * @param config Process Tap 配置
     * @param pid 目标进程 PID
     */
    ProcessTapManager(const TapConfig& config, pid_t pid);

    /**
     * 析构函数（自动清理资源）
     *
     * 调用 destroyTap() 清理所有资源。
     */
    ~ProcessTapManager();

    // 禁止拷贝和赋值（资源唯一性）
    ProcessTapManager(const ProcessTapManager&) = delete;
    ProcessTapManager& operator=(const ProcessTapManager&) = delete;

    /**
     * 创建 Process Tap
     *
     * Phase 2 重构后的步骤：
     * 1. 创建 AudioProcess 对象（业务对象）
     * 2. 调用 AudioHardwareCreateProcessTap（CoreAudio API）
     * 3. 创建 AudioTap 对象（业务对象）
     *
     * @return 成功返回 true，失败返回 false（调用 getLastError() 查看详情）
     */
    bool createTap();

    /**
     * 销毁 Process Tap
     *
     * 调用 AudioHardwareDestroyProcessTap 并清理业务对象。
     * 此方法是幂等的（多次调用安全）。
     */
    void destroyTap();

    /**
     * 获取 AudioProcess 对象（Phase 2 新增）
     *
     * @return AudioProcess 指针（非拥有），如果未创建返回 nullptr
     */
    bitbook::business::AudioProcess* getProcess() const {
        return process_.get();
    }

    /**
     * 获取 AudioTap 对象（Phase 2 新增）
     *
     * @return AudioTap 指针（非拥有），如果未创建返回 nullptr
     */
    bitbook::business::AudioTap* getTap() const {
        return tap_.get();
    }

    /**
     * 获取 Tap UUID（便捷方法，兼容旧接口）
     *
     * @return Tap UUID，如果未创建则返回 nullptr
     */
    CFUUIDRef getTapUUID() const {
        return tap_ ? tap_->getUUID() : nullptr;
    }

    /**
     * 获取最后一次操作的错误信息
     *
     * @return 错误信息字符串
     */
    std::string getLastError() const { return lastError_; }

    /**
     * 检查 Tap 是否已创建
     *
     * @return 已创建返回 true，否则返回 false
     */
    bool isCreated() const { return tap_ != nullptr; }

    /**
     * 获取目标进程 PID
     *
     * @return 进程 PID
     */
    pid_t getPID() const { return pid_; }

private:
    TapConfig config_;                                          // Process Tap 配置
    pid_t pid_;                                                 // 目标进程 PID
    std::unique_ptr<bitbook::business::AudioProcess> process_;   // ⭐ 业务对象（拥有所有权）
    std::unique_ptr<bitbook::business::AudioTap> tap_;           // ⭐ 业务对象（拥有所有权）
    AudioObjectID tapID_;                                       // Tap AudioObjectID（用于销毁）
    std::string lastError_;                                     // 最后一次错误信息

    /**
     * 验证 PID 有效性
     *
     * 检查：
     * - PID > 0
     * - 进程存在（使用 kill(pid, 0)）
     *
     * @return 有效返回 true，否则返回 false
     *
     * @note 沙箱环境下可能失败，实际验证在 AudioHardwareCreateProcessTap 中进行
     */
    bool validatePID() const;

    /**
     * 设置错误信息
     *
     * @param error 错误信息
     */
    void setError(const std::string& error) {
        lastError_ = error;
    }
};

#endif // PROCESS_TAP_MANAGER_H
