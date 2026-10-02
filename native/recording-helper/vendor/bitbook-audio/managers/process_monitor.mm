#import "process_monitor.h"
#import "utils/logger.h"
#import <Foundation/Foundation.h>

using namespace bitbook::business;
using namespace bitbook::utils;

// ==================== ProcessMonitor 实现 ====================

ProcessMonitor::ProcessMonitor() {
    Logger::info("ProcessMonitor: 已创建");
}

ProcessMonitor::~ProcessMonitor() {
    stopAll();
    Logger::info("ProcessMonitor: 已销毁");
}

bool ProcessMonitor::startMonitoring(pid_t pid) {
    @autoreleasepool {
        // 检查是否已在监控中
        if (processes_.find(pid) != processes_.end()) {
            Logger::infof("ProcessMonitor: 进程 %d 已在监控中，跳过", pid);
            return true;
        }

        // 创建 AudioProcess 对象
        Logger::infof("ProcessMonitor: 开始监控进程 %d", pid);

        auto audioProcess = std::make_unique<AudioProcess>(pid);

        if (audioProcess->getProcessID() == kAudioObjectUnknown) {
            Logger::warningf("ProcessMonitor: 无法找到 PID %d 对应的音频进程（可能无音频输出）", pid);
            return false;
        }

        Logger::infof("ProcessMonitor: 找到音频进程 '%s' (PID=%d, ProcessID=%u)",
                     audioProcess->getProcessName().c_str(),
                     pid,
                     audioProcess->getProcessID());

        // 创建内部观察者
        auto internalObserver = std::make_unique<InternalObserver>(this, pid);

        // 注册观察者到 AudioProcess
        audioProcess->addRunningStateObserver(internalObserver.get());

        // 保存对象
        processes_[pid] = std::move(audioProcess);
        internalObservers_[pid] = std::move(internalObserver);

        Logger::infof("✅ ProcessMonitor: 进程 %d 监控已启动", pid);
        return true;
    }
}

void ProcessMonitor::stopMonitoring(pid_t pid) {
    @autoreleasepool {
        // 检查进程是否存在
        auto it = processes_.find(pid);
        if (it == processes_.end()) {
            Logger::infof("ProcessMonitor: 进程 %d 不在监控中，跳过", pid);
            return;
        }

        Logger::infof("ProcessMonitor: 停止监控进程 %d", pid);

        // 移除观察者
        auto obsIt = internalObservers_.find(pid);
        if (obsIt != internalObservers_.end()) {
            it->second->removeRunningStateObserver(obsIt->second.get());
            internalObservers_.erase(obsIt);
        }

        // 移除进程对象
        processes_.erase(it);

        Logger::infof("✅ ProcessMonitor: 进程 %d 监控已停止", pid);
    }
}

void ProcessMonitor::stopAll() {
    @autoreleasepool {
        if (processes_.empty()) {
            return;
        }

        Logger::infof("ProcessMonitor: 停止所有监控（共 %zu 个进程）", processes_.size());

        // 移除所有观察者
        for (auto& [pid, process] : processes_) {
            auto obsIt = internalObservers_.find(pid);
            if (obsIt != internalObservers_.end()) {
                process->removeRunningStateObserver(obsIt->second.get());
            }
        }

        // 清空所有映射
        internalObservers_.clear();
        processes_.clear();

        Logger::info("✅ ProcessMonitor: 所有监控已停止");
    }
}

bool ProcessMonitor::isRunning(pid_t pid) const {
    // 查找进程
    auto it = processes_.find(pid);
    if (it == processes_.end()) {
        return false;
    }

    // 检查运行状态
    return it->second->isRunning();
}

std::set<pid_t> ProcessMonitor::getMonitoredProcesses() const {
    std::set<pid_t> pids;
    for (const auto& [pid, _] : processes_) {
        pids.insert(pid);
    }
    return pids;
}

size_t ProcessMonitor::getRunningCount() const {
    size_t count = 0;
    for (const auto& [pid, process] : processes_) {
        if (process->isRunning()) {
            ++count;
        }
    }
    return count;
}

void ProcessMonitor::addObserver(PropertyObserver* observer) {
    if (!observer) {
        return;
    }

    observers_.insert(observer);
    Logger::infof("ProcessMonitor: 添加观察者（当前共 %zu 个）", observers_.size());
}

void ProcessMonitor::removeObserver(PropertyObserver* observer) {
    if (!observer) {
        return;
    }

    observers_.erase(observer);
    Logger::infof("ProcessMonitor: 移除观察者（当前共 %zu 个）", observers_.size());
}

void ProcessMonitor::notifyObservers(pid_t pid, AudioObjectID objectID,
                                    const AudioObjectPropertyAddress& address) {
    Logger::infof("ProcessMonitor: 通知观察者（进程 %d 状态变化）", pid);

    for (auto* observer : observers_) {
        if (observer) {
            observer->onPropertyChanged(objectID, address);
        }
    }
}

// ==================== InternalObserver 实现 ====================

void ProcessMonitor::InternalObserver::onPropertyChanged(
    AudioObjectID objectID,
    const AudioObjectPropertyAddress& address)
{
    // 只处理 kAudioProcessPropertyIsRunning
    if (address.mSelector != kAudioProcessPropertyIsRunning) {
        return;
    }

    Logger::infof("ProcessMonitor::InternalObserver: 进程 %d 状态变化", pid_);

    // 转发给父 ProcessMonitor 的外部观察者
    if (parent_) {
        parent_->notifyObservers(pid_, objectID, address);
    }
}
