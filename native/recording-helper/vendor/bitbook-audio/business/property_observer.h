#ifndef PROPERTY_OBSERVER_H
#define PROPERTY_OBSERVER_H

#include <CoreAudio/CoreAudio.h>

namespace bitbook::business {

/**
 * @brief 属性观察者接口
 *
 * 该接口定义了观察者模式的核心方法，用于监听 CoreAudio 对象属性变化。
 * 实现此接口的类可以注册为 AudioProcess 的观察者，在进程运行状态发生
 * 变化时接收通知。
 *
 * 使用场景：
 * - 监听目标进程的运行状态 (kAudioProcessPropertyIsRunning)
 * - 实现 autoStop 功能 (进程退出时自动停止录制)
 * - 响应其他 CoreAudio 属性变化
 *
 * 示例:
 * @code
 * class RecordingEngine : public PropertyObserver {
 * public:
 *     void onPropertyChanged(AudioObjectID objectID,
 *                            AudioObjectPropertyAddress address) override {
 *         if (address.mSelector == kAudioProcessPropertyIsRunning) {
 *             // 处理进程状态变化
 *         }
 *     }
 * };
 * @endcode
 */
class PropertyObserver {
public:
    virtual ~PropertyObserver() = default;

    /**
     * @brief 属性变化回调方法
     *
     * 当注册的 CoreAudio 对象属性发生变化时，此方法会被调用。
     *
     * @param objectID CoreAudio 对象 ID (例如 ProcessID)
     * @param address 属性地址，包含 mSelector (属性选择器)、mScope、mElement
     *
     * @note 此方法在 CoreAudio 线程中调用，实现时需要注意线程安全
     * @note 不应在此方法中执行耗时操作，避免阻塞音频线程
     */
    virtual void onPropertyChanged(AudioObjectID objectID,
                                   const AudioObjectPropertyAddress& address) = 0;
};

} // namespace bitbook::business

#endif // PROPERTY_OBSERVER_H
