#ifndef RUNTIME_CONFIG_H
#define RUNTIME_CONFIG_H

/**
 * 运行时控制配置
 *
 * CLI 工具特定的配置（Apple GUI 示例中不存在）
 *
 * 说明：
 * Apple 的官方示例是 GUI 应用，用户通过界面按钮手动启动和停止录制
 * 本项目是 CLI 工具，需要通过配置或命令行参数控制录制时长
 *
 * 配置字段：
 * - durationSeconds: 录制持续时间（秒）
 *   - 0: 无限录制（需要手动停止，如 Ctrl+C，或配合 autoStopOnProcessExit=true）
 *   - >0: 自动停止录制（秒数到期后自动停止）
 * - autoStopOnProcessExit: 进程退出时自动停止录制
 *   - true: 当被 Tap 的目标进程退出时，自动停止录制
 *   - false: 不监控进程状态，由 durationSeconds 或手动停止控制
 */
struct RuntimeConfig {
    /**
     * 录制持续时间（秒）
     * 默认值：10
     *
     * 取值范围：
     * - 0: 无限录制，需要手动停止（Ctrl+C）或配合 autoStopOnProcessExit=true 自动停止
     * - 1 ~ 86400: 录制指定秒数后自动停止（最大 24 小时）
     *
     * 使用场景：
     * - durationSeconds=0 + autoStopOnProcessExit=false: 长时间录制，手动 Ctrl+C 停止
     * - durationSeconds=0 + autoStopOnProcessExit=true: 录制直到被 Tap 的进程停止
     * - durationSeconds=30 + autoStopOnProcessExit=false: 录制 30 秒后自动停止
     * - durationSeconds=30 + autoStopOnProcessExit=true: 30 秒内如果进程停止则提前停止，否则 30 秒后停止
     */
    int durationSeconds = 10;

    /**
     * 进程退出时自动停止录制（V1.1 新增）
     * 默认值：false
     *
     * 说明：
     * - 启用后，使用 CoreAudio 属性监听 (kAudioProcessPropertyIsRunning) 监控目标进程状态
     * - 当被 Tap 的进程退出时，自动停止录制
     * - 完全兼容沙箱环境（不使用 kill(pid, 0) 等系统调用）
     * - 对标 Apple 官方示例的进程监控机制
     *
     * 适用场景：
     * - 录制应用音频，应用关闭时自动停止录制
     * - 避免录制无意义的静音数据
     * - 无人值守的自动化录制任务
     *
     * 注意：
     * - 仅在录制模式包含 Tap 时有效（mode=tap 或 mode=tap-and-mic）
     * - mic-only 模式下此配置无效
     */
    bool autoStopOnProcessExit = false;

    /**
     * 是否启用进程黑名单过滤（仅影响全局模式）
     * 默认值：true
     *
     * 说明：
     * - true: RecordingEngine 会跳过黑名单进程
     * - false: 捕获所有进程（用于对齐 audioFmtConvert 行为）
     */
    bool enableProcessBlacklist = true;

    // 验证配置有效性
    bool isValid() const;

    // 打印配置（用于调试）
    void print() const;

    /**
     * 是否为无限录制模式
     * @return true 如果 durationSeconds == 0
     */
    bool isUnlimitedDuration() const {
        return durationSeconds == 0;
    }
};

#endif // RUNTIME_CONFIG_H
