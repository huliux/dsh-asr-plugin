// audio_device_manager.h
// 音频设备管理器 - 查找和管理系统音频设备
//
// 功能:
// - 获取系统默认输入设备（麦克风）
// - 查询设备 UID 和名称
// - 枚举所有音频设备
// - 检查设备输入/输出能力

#ifndef AUDIO_DEVICE_MANAGER_H
#define AUDIO_DEVICE_MANAGER_H

#include <CoreAudio/CoreAudio.h>
#include <string>
#include <vector>

namespace bitbook {

/**
 * 音频设备信息结构
 */
struct AudioDeviceInfo {
    AudioObjectID deviceID;  // 设备 ID
    std::string uid;         // 设备唯一标识符
    std::string name;        // 设备名称
    bool isInput;            // 是否是输入设备
    bool isOutput;           // 是否是输出设备
};

/**
 * 音频设备管理器
 * 提供系统音频设备的查询和管理功能
 */
class AudioDeviceManager {
public:
    /**
     * 获取系统默认输入设备（麦克风）
     * @return 设备 ID，如果失败返回 kAudioObjectUnknown
     *
     * 使用场景：
     * - 自动选择麦克风进行录音
     * - 无需用户手动指定设备
     */
    static AudioObjectID getDefaultInputDevice();

    /**
     * 获取系统默认输出设备（扬声器/耳机）
     * @return 设备 ID，如果失败返回 kAudioObjectUnknown
     *
     * 使用场景：
     * - Process Tap 绑定系统当前播放设备
     * - 无需用户手动指定输出设备
     */
    static AudioObjectID getDefaultOutputDevice();

    /**
     * 获取设备的唯一标识符 (UID)
     * @param deviceID 设备 ID
     * @return 设备 UID 字符串，失败返回空字符串
     *
     * UID 示例：
     * - "AppleHDAEngineInput:1B,0,1,0:1" (内置麦克风)
     * - "AppleHDAEngineOutput:1B,0,1,1:0" (内置扬声器)
     */
    static std::string getDeviceUID(AudioObjectID deviceID);

    /**
     * 获取设备的显示名称
     * @param deviceID 设备 ID
     * @return 设备名称，失败返回 "Unknown"
     *
     * 名称示例：
     * - "MacBook Pro Microphone"
     * - "External Microphone"
     */
    static std::string getDeviceName(AudioObjectID deviceID);

    /**
     * 枚举系统所有音频设备
     * @return 设备信息列表
     *
     * 包含所有输入和输出设备
     * 可用于用户界面显示设备列表
     */
    static std::vector<AudioDeviceInfo> enumerateDevices();

    /**
     * 检查设备是否有输入流（麦克风）
     * @param deviceID 设备 ID
     * @return true 如果设备有输入流
     *
     * 用于判断设备是否可以录音
     */
    static bool hasInputStream(AudioObjectID deviceID);

    /**
     * 检查设备是否有输出流（扬声器）
     * @param deviceID 设备 ID
     * @return true 如果设备有输出流
     *
     * 用于判断设备是否可以播放
     */
    static bool hasOutputStream(AudioObjectID deviceID);
};

} // namespace bitbook

#endif // AUDIO_DEVICE_MANAGER_H
