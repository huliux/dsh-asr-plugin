#ifndef PROCESS_MONITOR_H
#define PROCESS_MONITOR_H

#include "business/audio_process.h"
#include "business/property_observer.h"
#include <map>
#include <memory>
#include <set>
#include <sys/types.h>

/**
 * 进程监控管理器 (Phase 4.2)
 *
 * 职责：管理多个进程的监控和生命周期
 *
 * 对应 Apple 官方示例：
 * - Model.swift: 管理进程列表
 * - AudioProcess.swift: 单个进程监控
 *
 * 核心功能：
 * - 监控多个进程的运行状态
 * - 进程退出时通知观察者
 * - 支持动态添加/移除监控
 *
 * 使用示例：
 * ```cpp
 * ProcessMonitor monitor;
 * monitor.addObserver(this);
 *
 * // 添加进程监控
 * monitor.startMonitoring(1234);
 * monitor.startMonitoring(5678);
 *
 * // 查询状态
 * bool running = monitor.isRunning(1234);
 * auto pids = monitor.getMonitoredProcesses();
 *
 * // 停止监控
 * monitor.stopMonitoring(1234);
 * monitor.stopAll();
 * ```
 */
class ProcessMonitor {
public:
    /**
     * 构造函数
     */
    ProcessMonitor();

    /**
     * 析构函数 - 自动停止所有监控
     */
    ~ProcessMonitor();

    // 禁止拷贝
    ProcessMonitor(const ProcessMonitor&) = delete;
    ProcessMonitor& operator=(const ProcessMonitor&) = delete;

    /**
     * 开始监控进程
     *
     * @param pid 系统 PID
     * @return 成功返回 true，失败返回 false（进程不存在或无音频）
     *
     * @note 如果进程已在监控中，直接返回 true（幂等操作）
     */
    bool startMonitoring(pid_t pid);

    /**
     * 停止监控进程
     *
     * @param pid 系统 PID
     *
     * @note 如果进程不在监控中，忽略（幂等操作）
     */
    void stopMonitoring(pid_t pid);

    /**
     * 停止所有监控
     */
    void stopAll();

    /**
     * 检查进程是否在运行
     *
     * @param pid 系统 PID
     * @return 运行中返回 true，否则返回 false
     *
     * @note 如果进程不在监控中，返回 false
     */
    bool isRunning(pid_t pid) const;

    /**
     * 获取当前监控的进程列表
     *
     * @return 进程 PID 集合
     */
    std::set<pid_t> getMonitoredProcesses() const;

    /**
     * 获取运行中的进程数量
     *
     * @return 运行中进程数
     */
    size_t getRunningCount() const;

    /**
     * 注册观察者（进程退出时通知）
     *
     * @param observer 观察者指针（非拥有）
     *
     * @note 同一观察者可多次注册，但只会通知一次
     */
    void addObserver(bitbook::business::PropertyObserver* observer);

    /**
     * 移除观察者
     *
     * @param observer 观察者指针
     */
    void removeObserver(bitbook::business::PropertyObserver* observer);

private:
    /**
     * PID → AudioProcess 对象映射
     */
    std::map<pid_t, std::unique_ptr<bitbook::business::AudioProcess>> processes_;

    /**
     * 观察者列表
     */
    std::set<bitbook::business::PropertyObserver*> observers_;

    /**
     * 内部观察者类（监听 AudioProcess 事件并转发）
     *
     * 为每个监控的进程创建一个内部观察者，接收 AudioProcess 的通知，
     * 然后转发给外部观察者。
     */
    class InternalObserver : public bitbook::business::PropertyObserver {
    public:
        /**
         * 构造函数
         *
         * @param parent 父 ProcessMonitor 对象
         * @param pid 监控的进程 PID
         */
        InternalObserver(ProcessMonitor* parent, pid_t pid)
            : parent_(parent), pid_(pid) {}

        /**
         * 属性变化回调
         *
         * @param objectID CoreAudio 对象 ID
         * @param address 属性地址
         */
        void onPropertyChanged(AudioObjectID objectID,
                              const AudioObjectPropertyAddress& address) override;

    private:
        ProcessMonitor* parent_;  // 非拥有指针
        pid_t pid_;
    };

    /**
     * PID → 内部观察者映射
     */
    std::map<pid_t, std::unique_ptr<InternalObserver>> internalObservers_;

    /**
     * 通知外部观察者
     *
     * @param pid 进程 PID
     * @param objectID CoreAudio 对象 ID
     * @param address 属性地址
     */
    void notifyObservers(pid_t pid, AudioObjectID objectID,
                        const AudioObjectPropertyAddress& address);
};

#endif // PROCESS_MONITOR_H
