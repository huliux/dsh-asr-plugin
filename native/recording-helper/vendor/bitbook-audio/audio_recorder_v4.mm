// audio_recorder_v4.mm
// Audio Recorder V4 - 使用 C 函数 IOProc（模仿苹果官方示例）

#import "audio_recorder_v4.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <set>
#import <algorithm>
#import <chrono>
#import <cmath>
#import <filesystem>
#import <iomanip>
#import <sstream>
#import <mutex>

namespace bitbook {

namespace {

constexpr int kTimestampPrecision = 7;

double getCurrentTimeSeconds() {
    auto now = std::chrono::system_clock::now();
    auto seconds = std::chrono::duration_cast<std::chrono::duration<double>>(
        now.time_since_epoch());
    return seconds.count();
}

std::string formatTimestamp(double seconds) {
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(kTimestampPrecision) << seconds;
    return oss.str();
}

std::string joinPath(const std::string& dir, const std::string& filename) {
    if (dir.empty()) {
        return filename;
    }
    if (dir.back() == '/') {
        return dir + filename;
    }
    return dir + "/" + filename;
}

AudioStreamBasicDescription makePcmFormat(double sampleRate,
                                          int channels,
                                          int bitsPerSample,
                                          bool isFloat) {
    AudioStreamBasicDescription format = {};
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = isFloat
        ? (kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked)
        : (kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked);
    format.mBitsPerChannel = static_cast<UInt32>(bitsPerSample);
    format.mChannelsPerFrame = static_cast<UInt32>(channels);
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = (bitsPerSample / 8) * channels;
    format.mBytesPerPacket = format.mBytesPerFrame;
    return format;
}

AudioStreamBasicDescription makeFloatClientFormat(double sampleRate, int channels) {
    AudioStreamBasicDescription format = {};
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    format.mBitsPerChannel = 32;
    format.mChannelsPerFrame = static_cast<UInt32>(channels);
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = sizeof(Float32) * channels;
    format.mBytesPerPacket = format.mBytesPerFrame;
    return format;
}

} // namespace

// ==================== C 函数（模仿苹果官方示例）====================

/**
 * Helper 函数：创建 AudioObjectPropertyAddress
 */
constexpr AudioObjectPropertyAddress PropertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) noexcept {
    return {selector, scope, element};
}

struct ChunkedWriterConfig {
    AudioStreamBasicDescription inputFormat;
    AudioStreamBasicDescription outputFormat;
    AudioStreamBasicDescription clientFormat;
    AudioFileTypeID fileType;
    std::string extension;
    std::string outputDir;
    std::string fixedOutputPath;
    std::string sourceLabel;
    double chunkSizeSeconds = 0.0;
};

class AudioRecorderV4::ChunkedAudioFileWriter {
public:
    explicit ChunkedAudioFileWriter(const ChunkedWriterConfig& config)
        : config_(config)
        , file_(nullptr)
        , tempPath_("")
        , currentChunkStartSec_(0.0)
        , started_(false)
        , stopped_(false)
        , framesWritten_(0)
        , chunkFrames_(0)
        , chunkIndex_(0)
        , inputSampleRate_(config.inputFormat.mSampleRate)
        , inputChannels_(static_cast<int>(config.inputFormat.mChannelsPerFrame))
        , outputChannels_(static_cast<int>(config.clientFormat.mChannelsPerFrame))
        , needsRemix_(inputChannels_ != outputChannels_) {
        if (config_.chunkSizeSeconds > 0.0 && inputSampleRate_ > 0.0) {
            chunkFrames_ = static_cast<uint64_t>(
                std::llround(config_.chunkSizeSeconds * inputSampleRate_));
        }
    }

    ~ChunkedAudioFileWriter() {
        cancel();
    }

    bool start(double startTimeSeconds) {
        if (started_) {
            return true;
        }
        started_ = true;
        currentChunkStartSec_ = startTimeSeconds;
        return openInitialFile();
    }

    bool write(const AudioBuffer& buffer, UInt32 frames) {
        if (stopped_) {
            return false;
        }
        if (!started_) {
            if (!start(getCurrentTimeSeconds())) {
                return false;
            }
        }
        if (frames == 0 || buffer.mDataByteSize == 0) {
            return true;
        }

        UInt32 framesRemaining = frames;
        UInt32 frameOffset = 0;

        while (framesRemaining > 0) {
            if (!file_) {
                if (!openInitialFile()) {
                    return false;
                }
            }

            UInt32 framesToWrite = framesRemaining;
            if (chunkFrames_ > 0) {
                uint64_t framesAvailable = chunkFrames_ - framesWritten_;
                if (framesAvailable == 0) {
                    rotateChunk();
                    continue;
                }
                framesToWrite = static_cast<UInt32>(
                    std::min<uint64_t>(framesRemaining, framesAvailable));
            }

            if (!writeFrames(buffer, frameOffset, framesToWrite)) {
                return false;
            }

            framesWritten_ += framesToWrite;
            framesRemaining -= framesToWrite;
            frameOffset += framesToWrite;

            if (chunkFrames_ > 0 && framesWritten_ >= chunkFrames_) {
                rotateChunk();
            }
        }

        return true;
    }

    bool updateInputFormat(const AudioStreamBasicDescription& format) {
        const double sampleRate = format.mSampleRate;
        if (!std::isfinite(sampleRate) || sampleRate <= 0.0) return false;
        if (sampleRate == inputSampleRate_ && format.mChannelsPerFrame == inputChannels_) return true;
        const double endTime = currentChunkStartSec_ + framesWritten_ / inputSampleRate_;
        closeFile();
        finalizeChunk(/*removeIfEmpty=*/true, endTime);
        currentChunkStartSec_ = endTime;
        framesWritten_ = 0;
        inputSampleRate_ = sampleRate;
        config_.inputFormat = format;
        config_.clientFormat.mSampleRate = sampleRate;
        inputChannels_ = static_cast<int>(format.mChannelsPerFrame);
        needsRemix_ = inputChannels_ != outputChannels_;
        chunkFrames_ = config_.chunkSizeSeconds > 0.0
            ? static_cast<uint64_t>(std::llround(config_.chunkSizeSeconds * sampleRate)) : 0;
        return true;
    }

    void stop() {
        if (stopped_) {
            return;
        }
        stopped_ = true;
        closeFile();
        finalizeChunk(/*removeIfEmpty=*/true);
    }

    void cancel() {
        if (file_) {
            ExtAudioFileDispose(file_);
            file_ = nullptr;
        }
        if (!tempPath_.empty()) {
            std::error_code err;
            std::filesystem::remove(tempPath_, err);
            tempPath_.clear();
        }
        stopped_ = true;
    }

private:
    bool openInitialFile() {
        if (file_) {
            return true;
        }

        if (!config_.fixedOutputPath.empty()) {
            return openFile(config_.fixedOutputPath);
        }

        if (config_.outputDir.empty()) {
            return false;
        }

        return openNewChunkFile();
    }

    bool openNewChunkFile() {
        std::ostringstream oss;
        oss << "temp_chunk_" << config_.sourceLabel << "_" << chunkIndex_++ << "."
            << config_.extension;
        tempPath_ = joinPath(config_.outputDir, oss.str());
        return openFile(tempPath_);
    }

    bool openFile(const std::string& path) {
        CFURLRef url = CFURLCreateFromFileSystemRepresentation(
            nullptr,
            reinterpret_cast<const UInt8*>(path.c_str()),
            path.length(),
            false);

        if (!url) {
            return false;
        }

        ExtAudioFileRef file = nullptr;
        OSStatus error = ExtAudioFileCreateWithURL(
            url,
            config_.fileType,
            &config_.outputFormat,
            nullptr,
            kAudioFileFlags_EraseFile,
            &file);

        CFRelease(url);

        if (error != noErr || !file) {
            return false;
        }

        error = ExtAudioFileSetProperty(
            file,
            kExtAudioFileProperty_ClientDataFormat,
            sizeof(config_.clientFormat),
            &config_.clientFormat);

        if (error != noErr) {
            ExtAudioFileDispose(file);
            return false;
        }

        file_ = file;
        framesWritten_ = 0;
        return true;
    }

    void rotateChunk() {
        if (chunkFrames_ == 0) {
            return;
        }
        double endTimeSec = currentChunkStartSec_ +
            static_cast<double>(framesWritten_) / inputSampleRate_;
        closeFile();
        finalizeChunk(/*removeIfEmpty=*/false, endTimeSec);
        currentChunkStartSec_ = endTimeSec;
        framesWritten_ = 0;
        openNewChunkFile();
    }

    void finalizeChunk(bool removeIfEmpty) {
        double endTimeSec = currentChunkStartSec_;
        if (inputSampleRate_ > 0.0) {
            endTimeSec += static_cast<double>(framesWritten_) / inputSampleRate_;
        }
        finalizeChunk(removeIfEmpty, endTimeSec);
    }

    void finalizeChunk(bool removeIfEmpty, double endTimeSec) {
        if (tempPath_.empty()) {
            return;
        }

        if (framesWritten_ == 0 && removeIfEmpty) {
            std::error_code err;
            std::filesystem::remove(tempPath_, err);
            tempPath_.clear();
            return;
        }

        std::string finalName = formatTimestamp(currentChunkStartSec_) + "-" +
            formatTimestamp(endTimeSec) + "-" + config_.sourceLabel + "." +
            config_.extension;
        std::string finalPath = joinPath(config_.outputDir, finalName);

        std::error_code err;
        std::filesystem::rename(tempPath_, finalPath, err);
        if (!err) {
            tempPath_.clear();
        }
    }

    void closeFile() {
        if (file_) {
            ExtAudioFileDispose(file_);
            file_ = nullptr;
        }
    }

    bool writeFrames(const AudioBuffer& buffer, UInt32 frameOffset, UInt32 frames) {
        if (!file_) {
            return false;
        }

        const auto* inputData = static_cast<const Float32*>(buffer.mData);
        const Float32* writePtr = inputData + frameOffset * inputChannels_;
        UInt32 writeChannels = static_cast<UInt32>(inputChannels_);

        if (needsRemix_) {
            remixBuffer_.resize(static_cast<size_t>(frames) * outputChannels_);
            Float32* out = remixBuffer_.data();

            if (inputChannels_ == 2 && outputChannels_ == 1) {
                for (UInt32 i = 0; i < frames; ++i) {
                    Float32 left = writePtr[i * 2];
                    Float32 right = writePtr[i * 2 + 1];
                    out[i] = (left + right) * 0.5f;
                }
            } else if (inputChannels_ == 1 && outputChannels_ == 2) {
                for (UInt32 i = 0; i < frames; ++i) {
                    Float32 mono = writePtr[i];
                    out[i * 2] = mono;
                    out[i * 2 + 1] = mono;
                }
            } else {
                for (UInt32 i = 0; i < frames; ++i) {
                    out[i] = writePtr[i * inputChannels_];
                }
            }

            writePtr = out;
            writeChannels = static_cast<UInt32>(outputChannels_);
        }

        AudioBufferList writeData;
        writeData.mNumberBuffers = 1;
        writeData.mBuffers[0].mNumberChannels = writeChannels;
        writeData.mBuffers[0].mData = const_cast<Float32*>(writePtr);
        writeData.mBuffers[0].mDataByteSize = frames * writeChannels * sizeof(Float32);

        ExtAudioFileWriteAsync(file_, frames, &writeData);
        return true;
    }

    ChunkedWriterConfig config_;
    ExtAudioFileRef file_;
    std::string tempPath_;
    double currentChunkStartSec_;
    bool started_;
    bool stopped_;
    uint64_t framesWritten_;
    uint64_t chunkFrames_;
    uint64_t chunkIndex_;
    double inputSampleRate_;
    int inputChannels_;
    int outputChannels_;
    bool needsRemix_;
    std::vector<Float32> remixBuffer_;
};

// Phase 4.6: 移除独立的 deviceChangedListener，改用 PropertyObserver 接口
// 属性变化通知现在通过 AggregateDeviceManager 的观察者机制传递

/**
 * C 函数 IOProc 回调
 * 模仿苹果官方示例：AudioTapSample/AudioRecorder.mm 中的 ioproc 函数
 */
/**
 * C 函数 IOProc 回调（模仿 Apple 官方示例）
 * 参考：AudioTapSample/AudioRecorder.mm 中的 ioproc 函数
 *
 * 关键改进：
 * 1. 使用 ExtAudioFileWriteAsync（异步，不阻塞音频线程）
 * 2. 移除手动静音填充（CoreAudio 会自动处理空 Tap）
 * 3. 简化逻辑，信任 CoreAudio 的行为
 */
// 静态变量用于限制 DEBUG 日志输出频率
static uint64_t g_ioCallbackCount = 0;

static OSStatus AudioIOProc(
    AudioObjectID inDevice,
    const AudioTimeStamp* inNow,
    const AudioBufferList* inInputData,
    const AudioTimeStamp* inInputTime,
    AudioBufferList* outOutputData,
    const AudioTimeStamp* inOutputTime,
    void* inClientData) noexcept
{
    // ⚠️ 最关键的测试：IOProc 是否被调用？
    g_ioCallbackCount++;
    if (g_ioCallbackCount == 1) {
        NSLog(@"🎉🎉🎉 IOProc 首次被调用! deviceID=%u", inDevice);
    }

    // 获取 Recorder 实例
    auto* recorder = static_cast<AudioRecorderV4*>(inClientData);
    if (recorder == nullptr) {
        if (g_ioCallbackCount == 1) {
            NSLog(@"❌ 严重错误: recorder 指针为 null!");
        }
        return kAudioHardwareNoError;
    }

    size_t writerCount = recorder->getWriterCount();

    // ✅ 对齐 Apple: 即使 fileList 为空也不返回
    // 原因: adaptToDevice 可能在录制中动态创建文件
    // 我们继续处理，只是在写入时检查文件是否存在

    // 计算输入 buffer 数量和帧数
    UInt32 numberInputBuffers = 0;
    UInt32 numberFramesToRecord = 0;

    // ✅ Phase 4.5 修复：即使 inInputData 为空或无 buffer，也要写入 0 帧
    if (inInputData != nullptr && inInputData->mNumberBuffers > 0) {
        numberInputBuffers = inInputData->mNumberBuffers;
        // 只有在有有效数据时才计算帧数
        if (inInputData->mBuffers[0].mDataByteSize > 0) {
            numberFramesToRecord = inInputData->mBuffers[0].mDataByteSize /
                (inInputData->mBuffers[0].mNumberChannels * sizeof(Float32));
        }
    } else {
        // ⚠️ 空数据情况：写入 0 帧到所有文件（保持时间戳对齐）
        return kAudioHardwareNoError;
    }

    // DEBUG: 每 100 次回调打印一次，第1次立即打印
    if (g_ioCallbackCount == 1 || g_ioCallbackCount % 100 == 0) {
        NSLog(@"🔧 DEBUG IOProc[%llu]: buffers=%u, frames=%u, isRecording=%d, writerCount=%zu",
              g_ioCallbackCount, numberInputBuffers, numberFramesToRecord,
              recorder->isRecording(), writerCount);

        if (writerCount == 0 && g_ioCallbackCount == 1) {
            NSLog(@"⚠️  WARNING: IOProc 被调用但写入器为空！等待 adaptToDevice 创建写入器...");
        }
    }

    // ✅ Phase 4.5 修复：遍历所有 buffer，即使为空也写入
    // 对齐 Apple 官方示例：不检查 mDataByteSize，即使为 0 也写入
    for (size_t index = 0; index < numberInputBuffers; ++index) {
        AudioBuffer buffer = inInputData->mBuffers[index];

        if (recorder->isRecording() && index < writerCount) {
            recorder->writeInputData(index, buffer, numberFramesToRecord);
        }
    }

    return kAudioHardwareNoError;
}

// ==================== AudioRecorderV4 实现 ====================

AudioRecorderV4::AudioRecorderV4(const std::string& outputPath,
                                 AudioObjectID deviceID,
                                 const AudioStreamBasicDescription& format,
                                 const RecorderConfig* config,
                                 const std::string& processName)
    : outputPath_(outputPath)
    , deviceID_(deviceID)
    , format_(format)
    , ioProcID_(nullptr)
    , isRecording_(false)
    , recordingEnabled_(false)
    , config_(config)
    , processName_(processName)
    , pcmStdoutEnabled_(false)
    , pcmStdoutSampleRate_(16000.0)
    , pcmStdoutChannels_(1)
{
    NSLog(@"✅ AudioRecorderV4 构造: deviceID=%u, 基础路径=%s", deviceID, outputPath.c_str());
    if (config_ && !config_->fileNamePattern.empty()) {
        NSLog(@"   [Phase 3A.4] 使用语义化文件命名: pattern=%s, mode=%s",
              config_->fileNamePattern.c_str(), config_->modeLabel.c_str());
    }
}

AudioRecorderV4::~AudioRecorderV4() {
    stop();
    // Phase 4.6: 不再需要 unregisterListeners()，由 AggregateDeviceManager 管理
    cleanUpRecordingFiles();
    NSLog(@"🗑️ AudioRecorderV4 析构");
}

bool AudioRecorderV4::writeInputData(size_t index, const AudioBuffer& buffer, UInt32 frames) {
    if (index >= writers_.size() || !writers_[index] || index >= inputStreamIDs_.size()) {
        return false;
    }
    // A process tap can change rate without changing its stream count or tap list.
    // Refresh the converter before consuming this buffer, and close the old-rate tail.
    AudioStreamBasicDescription current = {};
    UInt32 size = sizeof(current);
    const auto address = PropertyAddress(kAudioStreamPropertyVirtualFormat);
    if (AudioObjectGetPropertyData(inputStreamIDs_[index], &address, 0, nullptr,
                                  &size, &current) != noErr ||
        !writers_[index]->updateInputFormat(current)) return false;
    // 同时输出 PCM 到 stdout（仅对第一个流，避免重复）
    if (pcmStdoutEnabled_ && index == 0 && frames > 0) {
        writePcmToStdout(buffer, frames);
    }
    return writers_[index]->write(buffer, frames);
}

void AudioRecorderV4::enablePcmStdout(double targetSampleRate, int targetChannels) {
    pcmStdoutEnabled_ = true;
    pcmStdoutSampleRate_ = targetSampleRate;
    pcmStdoutChannels_ = targetChannels;
    NSLog(@"✅ AudioRecorderV4: PCM stdout 输出已启用 (%.0fHz, %dch)",
          targetSampleRate, targetChannels);
}

void AudioRecorderV4::writePcmToStdout(const AudioBuffer& buffer, UInt32 frames) {
    if (frames == 0 || buffer.mDataByteSize == 0 || buffer.mData == nullptr) {
        return;
    }

    const Float32* inputData = static_cast<const Float32*>(buffer.mData);
    int inputChannels = static_cast<int>(buffer.mNumberChannels);
    int outputChannels = pcmStdoutChannels_;

    // 计算输出帧数（如果需要重采样）
    // 输入采样率来自设备流格式（通常 48kHz），输出目标 16kHz
    double inputSampleRate = 48000.0;  // Aggregate Device 默认采样率
    if (!inputStreamList_.empty()) {
        inputSampleRate = inputStreamList_[0].mSampleRate;
    }

    // 简单整数比降采样（48000/16000=3, 44100 不整除则用最近邻）
    double ratio = inputSampleRate / pcmStdoutSampleRate_;
    UInt32 outputFrames = static_cast<UInt32>(static_cast<double>(frames) / ratio);
    if (outputFrames == 0) {
        return;
    }

    // 非整数比警告（仅首次）
    static bool ratioWarned = false;
    double intPart;
    if (!ratioWarned && std::modf(ratio, &intPart) != 0.0) {
        NSLog(@"⚠️ AudioRecorderV4: 非整数降采样比 %.4f (%.0f → %.0f)，可能产生混叠",
              ratio, inputSampleRate, pcmStdoutSampleRate_);
        ratioWarned = true;
    }

    // 转换为 16bit PCM
    std::lock_guard<std::mutex> lock(pcmStdoutMutex_);
    pcmConvertBuffer_.resize(static_cast<size_t>(outputFrames) * outputChannels);

    for (UInt32 i = 0; i < outputFrames; ++i) {
        UInt32 srcFrame = static_cast<UInt32>(static_cast<double>(i) * ratio);
        if (srcFrame >= frames) {
            srcFrame = frames - 1;
        }

        Float32 sample = 0.0f;
        if (inputChannels == 1) {
            sample = inputData[srcFrame];
        } else if (inputChannels >= 2 && outputChannels == 1) {
            // 立体声转单声道：取平均
            sample = (inputData[srcFrame * inputChannels] +
                      inputData[srcFrame * inputChannels + 1]) * 0.5f;
        } else {
            sample = inputData[srcFrame * inputChannels];
        }

        // Float32 [-1.0, 1.0] → int16 [-32768, 32767]
        Float32 clamped = std::max(-1.0f, std::min(1.0f, sample));
        int16_t pcmSample = static_cast<int16_t>(clamped * 32767.0f);
        pcmConvertBuffer_[i] = pcmSample;
    }

    // 写入 stdout（二进制模式）
    size_t bytesToWrite = static_cast<size_t>(outputFrames) * outputChannels * sizeof(int16_t);
    fwrite(pcmConvertBuffer_.data(), 1, bytesToWrite, stdout);
    fflush(stdout);
}

/**
 * 流目录扫描（完全模仿 Apple 官方示例）
 * 参考：AudioTapSample/AudioRecorder.mm 中的 catalogDeviceStreams 方法
 *
 * 关键改进：
 * 1. 同时检查 Global 和 Input scope
 * 2. 移除复杂的去重逻辑
 * 3. 简化代码，信任 CoreAudio
 */
void AudioRecorderV4::catalogDeviceStreams() {
    inputStreamList_.clear();
    inputStreamIDs_.clear();
    outputStreamList_.clear();

    if (deviceID_ == kAudioObjectUnknown) {
        return;
    }

    // 尝试多个 scope 来获取流
    // Tap 流可能在 Input scope 而不是 Global scope
    std::vector<AudioObjectPropertyScope> scopes = {
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyScopeInput
    };

    std::set<AudioObjectID> processedStreams;  // 避免重复处理

    for (auto scope : scopes) {
        UInt32 size = 0;
        AudioObjectPropertyAddress address = {
            kAudioDevicePropertyStreams,
            scope,
            kAudioObjectPropertyElementMain
        };

        OSStatus error = AudioObjectGetPropertyDataSize(deviceID_, &address, 0, nullptr, &size);
        auto streamCount = size / sizeof(AudioObjectID);

        if (error != kAudioHardwareNoError || streamCount == 0) {
            continue;
        }

        std::vector<AudioObjectID> streamList(streamCount);
        error = AudioObjectGetPropertyData(deviceID_, &address, 0, nullptr, &size, streamList.data());

        if (error != kAudioHardwareNoError) {
            continue;
        }

        // 调整 streamList 大小以匹配实际数据
        streamList.resize(size / sizeof(AudioObjectID));

        NSLog(@"🔍 catalogDeviceStreams: scope=%u 发现 %zu 个流", scope, streamList.size());

        // 遍历每个流
        for (auto streamID : streamList) {
            // 跳过已处理的流
            if (processedStreams.count(streamID) > 0) {
                continue;
            }
            processedStreams.insert(streamID);

            // 获取流的格式
            AudioObjectPropertyAddress formatAddr = {
                kAudioStreamPropertyVirtualFormat,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };

            AudioStreamBasicDescription format;
            size = sizeof(AudioStreamBasicDescription);
            memset(&format, 0, size);

            error = AudioObjectGetPropertyData(streamID, &formatAddr, 0, nullptr, &size, &format);

            if (error == kAudioHardwareNoError) {
                // 获取流方向
                AudioObjectPropertyAddress dirAddr = {
                    kAudioStreamPropertyDirection,
                    kAudioObjectPropertyScopeGlobal,
                    kAudioObjectPropertyElementMain
                };

                UInt32 direction = 0;  // 0 = output, 1 = input
                size = sizeof(UInt32);
                AudioObjectGetPropertyData(streamID, &dirAddr, 0, nullptr, &size, &direction);

                NSLog(@"🔍 Stream %u: direction=%u, channels=%u, rate=%.0f (scope=%u)",
                      streamID, direction, format.mChannelsPerFrame, format.mSampleRate, scope);

                if (direction == 0) {
                    outputStreamList_.push_back(format);
                } else {
                    inputStreamList_.push_back(format);
                    inputStreamIDs_.push_back(streamID);
                }
            }
        }
    }

    NSLog(@"🔍 catalogDeviceStreams 完成: input=%zu, output=%zu",
          inputStreamList_.size(), outputStreamList_.size());
}

bool AudioRecorderV4::setup() {
    NSLog(@"🔧 AudioRecorderV4::setup() 开始");

    // 1. 扫描设备流（模仿苹果示例）
    catalogDeviceStreams();

    // ✅ 对齐 Apple 示例：首次扫描就确定流的状态
    // Apple 不做重试，直接依赖 Property Listener
    if (inputStreamList_.empty()) {
        NSLog(@"⚠️  setup: 未检测到输入流（可能是空 Tap）");
        NSLog(@"   提示: 请确保已选择进程并且进程正在播放音频");
        NSLog(@"   机制: Property Listener 会在音频流出现时自动重启录制");
        // ✅ 不返回 false，继续注册 Listener（等待自动适应）
    } else {
        NSLog(@"📋 检测到 %zu 个输入流，将为每个流创建独立文件", inputStreamList_.size());
    }

    // 2. 创建多个录音文件（每个输入流一个）
    // ✅ 如果没有流，makeRecordingFiles 会返回 false
    if (!makeRecordingFiles()) {
        NSLog(@"⚠️  setup: makeRecordingFiles 失败（可能暂无流）");
        NSLog(@"   继续: 注册 Property Listener，等待流出现时自动重启");
        // ✅ 不返回 false，允许 setup 继续（注册 Listener）
    }

    // 3. ⚠️  不在 setup 时创建 IOProc（对齐 Apple 示例）
    // Apple 示例在 startIO 时才创建 IOProcID,避免时序问题
    NSLog(@"✅ setup: 文件创建完成，将在 start() 时创建 IOProc");

    // Phase 4.6: 不再注册独立监听器，改用 PropertyObserver 接口
    // 监听器由 AggregateDeviceManager 统一管理

    return true;
}

bool AudioRecorderV4::start() {
    if (isRecording_) {
        NSLog(@"⚠️  start: 已经在录制中");
        return false;
    }

    // ✅ 修复：即使写入器为空也要启动 AudioDevice
    // 原因：Apple 示例在空 Tap 场景下也会启动 IO，IOProc 中检查文件是否存在
    // 这样可以让 Property Listener 在流出现时自动创建文件并写入
    if (writers_.empty()) {
        NSLog(@"⚠️  start: 没有输入流，但仍会启动 AudioDevice（等待流出现）");
        recordingEnabled_ = true;  // ✅ 标记用户希望录音（用于 adaptToDevice）
    }

    NSLog(@"Starting IO");

    // 🔍 DEBUG: 打印关键参数
    NSLog(@"🔍 DEBUG start(): deviceID_=%u, this=%p, AudioIOProc=%p",
          deviceID_, this, (void*)AudioIOProc);

    // ✅ 对齐 Apple: 在 start 时创建 IOProcID（原子操作）
    AudioDeviceIOProcID ioProcID = nullptr;
    OSStatus error = AudioDeviceCreateIOProcID(
        deviceID_,
        AudioIOProc,
        this,
        &ioProcID
    );

    if (error != kAudioHardwareNoError) {
        NSLog(@"❌ start: AudioDeviceCreateIOProcID 失败: OSStatus=%d", error);
        cleanUpRecordingFiles();
        return false;
    }

    ioProcID_ = ioProcID;  // 保存
    NSLog(@"✅ start: IOProc 创建成功, ioProcID=%p (deviceID=%u)", ioProcID_, deviceID_);

    if (!writers_.empty()) {
        double startTimeSec = getCurrentTimeSeconds();
        for (const auto& writer : writers_) {
            if (writer && !writer->start(startTimeSec)) {
                NSLog(@"❌ start: 写入器启动失败");
                AudioDeviceDestroyIOProcID(deviceID_, ioProcID_);
                ioProcID_ = nullptr;
                return false;
            }
        }
    }

    // ✅ 关键修复：完全信任 AudioDeviceStart（对齐 Apple 示例）
    // Apple 官方示例不检查 isRunning，直接信任 AudioDeviceStart 返回值
    NSLog(@"🎬 AudioDeviceStart...");

    error = AudioDeviceStart(deviceID_, ioProcID_);

    if (error != kAudioHardwareNoError) {
        NSLog(@"❌ start: AudioDeviceStart 失败: OSStatus=%d", error);
        AudioDeviceDestroyIOProcID(deviceID_, ioProcID_);
        ioProcID_ = nullptr;
        return false;
    }

    isRecording_ = true;
    recordingEnabled_ = true;  // 标记用户希望录音（用于 adaptToDevice）
    NSLog(@"✅ start: 录音已启动，等待 IOProc 回调（%zu 个写入器）", writers_.size());

    return true;
}

void AudioRecorderV4::stop() {
    if (!isRecording_) {
        return;
    }

    NSLog(@"Stopping IO");

    // 停止 IOProc
    AudioDeviceStop(deviceID_, ioProcID_);
    AudioDeviceDestroyIOProcID(deviceID_, ioProcID_);
    ioProcID_ = nullptr;

    for (const auto& writer : writers_) {
        if (writer) {
            writer->stop();
        }
    }

    // 清理录音文件
    cleanUpRecordingFiles();

    isRecording_ = false;
    recordingEnabled_ = false;  // 清除录音意图
}

/**
 * 适应设备变化（完全对齐 Apple 的 adaptToDevice）
 * 当 TapList 或 FullSubDeviceList 变化时被调用
 * 参考：AudioTapSample/AudioRecorder.mm line 131-148
 */
bool AudioRecorderV4::adaptToDevice(AudioObjectID deviceID) {
    NSLog(@"🔄 adaptToDevice: deviceID=%u (当前=%u), recordingEnabled=%d",
          deviceID, deviceID_, recordingEnabled_);

    // 1. 如果设备失效（deviceID == kAudioObjectUnknown）
    if (deviceID == kAudioObjectUnknown) {
        NSLog(@"⚠️  adaptToDevice: 设备失效，停止录制");
        if (isRecording_) {
            stop();
        }
        // Phase 4.6: 不再需要 unregisterListeners()，由 AggregateDeviceManager 管理
        cleanUpRecordingFiles();
        deviceID_ = kAudioObjectUnknown;
        return false;
    }

    // 2. 保存当前状态
    bool wasRecordingEnabled = recordingEnabled_;
    size_t oldInputCount = inputStreamList_.size();

    // 3. 重新扫描流
    catalogDeviceStreams();
    size_t newInputCount = inputStreamList_.size();

    NSLog(@"🔍 adaptToDevice: 流数量变化 %zu → %zu", oldInputCount, newInputCount);

    // 4. 如果流数量没有变化，直接返回
    if (oldInputCount == newInputCount) {
        NSLog(@"   流数量未变化，无需重新适配");
        return true;
    }

    // 5. 流数量发生变化，需要重新适配
    NSLog(@"🔄 adaptToDevice: 检测到流变化，进行重新适配...");

    // 6. 如果用户正在录制（recordingEnabled_ == true）
    if (wasRecordingEnabled) {
        NSLog(@"🔄 adaptToDevice: 检测到新流，重启录制...");

        // 6.1 停止当前录制（清理旧的 IOProc 和文件）
        if (isRecording_) {
            NSLog(@"   停止当前录制...");
            stop();
        }

        // 6.2 清理旧文件
        cleanUpRecordingFiles();

        // 6.3 如果有新流，重新创建文件并启动
        if (newInputCount > 0) {
            NSLog(@"   重新创建 %zu 个文件...", newInputCount);
            if (makeRecordingFiles()) {
                NSLog(@"   重新启动录制...");
                // ✅ 关键: 恢复 recordingEnabled_ 标志
                recordingEnabled_ = true;

                // ✅ 调用 start()（会自动创建 IOProcID 并启动）
                if (start()) {
                    NSLog(@"✅ adaptToDevice: 录制已重启");
                    return true;
                } else {
                    NSLog(@"❌ adaptToDevice: 重启录制失败");
                    return false;
                }
            } else {
                NSLog(@"❌ adaptToDevice: 重新创建文件失败");
                // 保持 recordingEnabled_ = true，等待下次变化
                recordingEnabled_ = true;
                return false;
            }
        } else {
            NSLog(@"⚠️  adaptToDevice: 流消失，保持等待状态");
            // 保持 recordingEnabled_ = true，等待流再次出现
            recordingEnabled_ = true;
            return false;
        }
    } else {
        // 7. 用户未在录制，只需准备文件
        if (newInputCount > 0) {
            NSLog(@"   准备文件（但不启动录制）...");
            cleanUpRecordingFiles();
            makeRecordingFiles();
        }
        return true;
    }
}

// Phase 4.6: 移除 registerListeners() 和 unregisterListeners()
// 改用 PropertyObserver 接口，由 AggregateDeviceManager 统一管理监听器

/**
 * 创建多个录音文件（每个输入流一个）
 * 完全模仿 Apple 官方示例：AudioTapSample/AudioRecorder.mm 的 makeRecordingFiles
 *
 * 关键修复：
 * 1. 对齐 Apple 示例：空流时返回 false（不创建文件）
 * 2. 依赖 Property Listener 的 adaptToDevice 自动重启
 * 3. 使用每个流的实际格式（而非通用格式）
 */
bool AudioRecorderV4::makeRecordingFiles() {
    // ✅ 对齐 Apple 示例：空流时拒绝创建文件
    // 参考：AudioTapSample/AudioRecorder.mm line 267
    // "Return if there are no input streams to record from."
    if (inputStreamList_.empty()) {
        NSLog(@"⚠️  makeRecordingFiles: 无输入流，拒绝创建文件（等待 Property Listener）");
        return false;  // ✅ 返回 false，阻止录制启动
    }

    // 为每个 **实际存在的** 输入流创建写入器
    auto streamFormats = &inputStreamList_;
    writers_.clear();
    writers_.reserve(streamFormats->size());

    bool chunked = config_ && config_->chunkSizeSeconds > 0.0;
    std::string outputDir = outputPath_;
    std::string basePath = outputPath_;
    if (!chunked) {
        size_t lastDot = basePath.find_last_of('.');
        if (lastDot != std::string::npos) {
            basePath = basePath.substr(0, lastDot);
        }
    }

    for (unsigned index = 0; index < streamFormats->size(); ++index) {
        auto inputFormat = streamFormats->at(index);

        double outputSampleRate = inputFormat.mSampleRate;
        int outputChannels = static_cast<int>(inputFormat.mChannelsPerFrame);
        int outputBits = static_cast<int>(inputFormat.mBitsPerChannel);
        bool outputFloat = (inputFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;

        if (config_) {
            if (config_->outputSampleRate > 0.0) {
                outputSampleRate = config_->outputSampleRate;
            }
            if (config_->outputChannels > 0) {
                outputChannels = config_->outputChannels;
            }
            if (config_->outputBitsPerSample > 0) {
                outputBits = config_->outputBitsPerSample;
            }
            if (config_->outputFloat) {
                outputFloat = true;
            } else if (config_->outputBitsPerSample > 0 || config_->outputSampleRate > 0.0 ||
                       config_->outputChannels > 0) {
                outputFloat = false;
            }
        }

        OutputFileFormat outputFormat = config_ ? config_->outputFormat : OutputFileFormat::Caf;
        AudioFileTypeID fileType = (outputFormat == OutputFileFormat::Wav)
            ? kAudioFileWAVEType
            : kAudioFileCAFType;
        std::string extension = (outputFormat == OutputFileFormat::Wav) ? "wav" : "caf";

        ChunkedWriterConfig writerConfig;
        writerConfig.inputFormat = inputFormat;
        writerConfig.outputFormat = makePcmFormat(
            outputSampleRate,
            outputChannels,
            outputBits,
            outputFloat);
        writerConfig.clientFormat = makeFloatClientFormat(
            inputFormat.mSampleRate,
            outputChannels);
        writerConfig.fileType = fileType;
        writerConfig.extension = extension;
        writerConfig.chunkSizeSeconds = config_ ? config_->chunkSizeSeconds : 0.0;

        if (chunked) {
            writerConfig.outputDir = outputDir;
            if (config_ && !config_->sourceLabel.empty()) {
                writerConfig.sourceLabel = config_->sourceLabel;
            } else {
                writerConfig.sourceLabel = (index == 0) ? "mic" : "tap";
            }
        } else {
            if (config_) {
                writerConfig.fixedOutputPath = config_->generateOutputPath(
                    static_cast<int>(index), processName_);
            } else {
                writerConfig.fixedOutputPath = basePath + "_Stream_" +
                    std::to_string(index) + "." + extension;
            }
        }

        auto writer = std::make_unique<ChunkedAudioFileWriter>(writerConfig);
        writers_.push_back(std::move(writer));
    }

    NSLog(@"✅ makeRecordingFiles: 成功创建 %zu 个写入器", writers_.size());
    return true;
}

/**
 * 清理所有录音文件
 */
void AudioRecorderV4::cleanUpRecordingFiles() {
    for (auto& writer : writers_) {
        if (writer) {
            writer->cancel();
        }
    }
    writers_.clear();
}

// ==================== Phase 4.6: PropertyObserver 接口实现 ====================

/**
 * 实现 PropertyObserver 接口
 * 当 AggregateDeviceManager 检测到设备属性变化时调用
 *
 * 对应 Apple 官方示例的 deviceChangedListener 回调
 * 监听关键属性：
 * - kAudioDevicePropertyDeviceIsAlive: 设备失效
 * - kAudioAggregateDevicePropertyTapList: Tap 列表变化
 * - kAudioAggregateDevicePropertyFullSubDeviceList: 子设备列表变化
 */
void AudioRecorderV4::onPropertyChanged(AudioObjectID objectID,
                                       const AudioObjectPropertyAddress& address) {
    @autoreleasepool {
        // 1. 处理设备存活状态变化
        if (address.mSelector == kAudioDevicePropertyDeviceIsAlive) {
            UInt32 isAlive = 0;
            UInt32 size = sizeof(isAlive);
            OSStatus err = AudioObjectGetPropertyData(objectID, &address, 0, nullptr, &size, &isAlive);

            if (err == noErr && !isAlive) {
                NSLog(@"⚠️ AudioRecorderV4: 设备失效，停止录制");
                stop();
                return;
            }
        }

        // 2. 处理 Tap/设备列表变化
        if (address.mSelector == kAudioAggregateDevicePropertyTapList ||
            address.mSelector == kAudioAggregateDevicePropertyFullSubDeviceList) {

            NSLog(@"🔄 AudioRecorderV4: 检测到设备变化 (selector=%u)，触发自适应", address.mSelector);

            // 调用 adaptToDevice 重新扫描流并重启录制（如果需要）
            adaptToDevice(objectID);
        }

        // 3. 其他属性变化（忽略）
        // 例如：kAudioAggregateDevicePropertyComposition
    }
}

} // namespace bitbook
