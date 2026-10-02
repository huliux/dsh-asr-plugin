// audio_recorder_v4.h
// Audio Recorder V4 - 使用 C 函数 IOProc（模仿苹果官方示例）
//
// 关键改变：
// 1. 使用 AudioDeviceCreateIOProcID（C 函数指针）而不是 Block
// 2. 添加流目录扫描功能
// 3. 使用 kAudioStreamPropertyVirtualFormat 获取格式
// 4. Phase 4.6: 实现 PropertyObserver 接口，支持设备变化自适应

#ifndef AUDIO_RECORDER_V4_H
#define AUDIO_RECORDER_V4_H

#include <CoreAudio/CoreAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include "config/recorder_config.h"  // Phase 3A.4
#include "business/property_observer.h"  // Phase 4.6

namespace bitbook {

// Phase 4.6: 实现 PropertyObserver 接口，通过 AggregateDeviceManager 接收设备变化通知
class AudioRecorderV4 : public bitbook::business::PropertyObserver {
public:
    // Phase 3A.4: 添加 config 和 processName 参数支持语义化文件命名
    AudioRecorderV4(const std::string& outputPath,
                    AudioObjectID deviceID,
                    const AudioStreamBasicDescription& format,
                    const RecorderConfig* config = nullptr,
                    const std::string& processName = "");
    ~AudioRecorderV4();

    bool setup();
    bool start();
    void stop();

    // 访问器（用于 C 函数回调）
    size_t getWriterCount() const { return writers_.size(); }
    const AudioStreamBasicDescription& getFormat() const { return format_; }
    bool isRecording() const { return isRecording_; }
    AudioObjectID getDeviceID() const { return deviceID_; }
    bool writeInputData(size_t index, const AudioBuffer& buffer, UInt32 frames);

    // PCM stdout 流输出（用于云端实时转写）
    void enablePcmStdout(double targetSampleRate, int targetChannels);
    bool isPcmStdoutEnabled() const { return pcmStdoutEnabled_; }

    // 访问器（用于诊断日志）
    size_t getInputStreamCount() const { return inputStreamList_.size(); }
    size_t getOutputStreamCount() const { return outputStreamList_.size(); }

    // ✅ 公开流扫描方法（用于轮询检查流是否准备好）
    void catalogDeviceStreams();

    // ✅ 新增：适应设备变化（模仿 Apple 示例）
    bool adaptToDevice(AudioObjectID deviceID);

    // Phase 4.6: 实现 PropertyObserver 接口
    // 当 AggregateDeviceManager 检测到设备变化时调用
    void onPropertyChanged(AudioObjectID objectID,
                          const AudioObjectPropertyAddress& address) override;

private:

    // 创建多个录音文件（每个输入流一个文件）
    bool makeRecordingFiles();

    // 清理录音文件
    void cleanUpRecordingFiles();


    std::string outputPath_;
    AudioObjectID deviceID_;
    AudioStreamBasicDescription format_;
    class ChunkedAudioFileWriter;
    std::vector<std::unique_ptr<ChunkedAudioFileWriter>> writers_;
    AudioDeviceIOProcID ioProcID_;  // C 函数 IOProc ID
    bool isRecording_;
    bool recordingEnabled_;  // ✅ 新增：用户是否希望录音（用于 adaptToDevice）

    // Phase 3A.4: 语义化文件命名支持
    const RecorderConfig* config_;  // 配置对象指针 (可选)
    std::string processName_;       // 进程名 (用于提取应用标识符)

    // 流信息（模仿苹果示例）
    std::vector<AudioStreamBasicDescription> inputStreamList_;
    std::vector<AudioObjectID> inputStreamIDs_;
    std::vector<AudioStreamBasicDescription> outputStreamList_;

    // PCM stdout 流输出
    bool pcmStdoutEnabled_;
    double pcmStdoutSampleRate_;
    int pcmStdoutChannels_;
    std::mutex pcmStdoutMutex_;
    std::vector<int16_t> pcmConvertBuffer_;
    void writePcmToStdout(const AudioBuffer& buffer, UInt32 frames);
};

} // namespace bitbook

#endif // AUDIO_RECORDER_V4_H
