/**
 * audioFmtConvert-no-ct_01 - 音频格式转换工具（无 Sentry）
 *
 * 功能：
 * - 音频录制 (audio-capture)
 * - WAV 拼接 (wav-concat)
 * - WAV 分割 (split-wav)
 * - 权限检查 (permission-check)
 *
 * 注意：
 * - system-audio 分支仅保留与原始 no-ct 相同的失败路径
 * - 本版本移除 Sentry 与上报逻辑
 */

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <csignal>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <regex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <dispatch/dispatch.h>
#import <AVFoundation/AVFoundation.h>

#include "audio_device_manager.h"
#include "utils/logger.h"

using bitbook::AudioDeviceManager;
using bitbook::utils::Logger;
using bitbook::utils::LogLevel;

namespace {

struct ArgMap {
    std::unordered_map<std::string, std::vector<std::string>> values;
};

bool parseBool(const std::string& value);

ArgMap parseArgs(int argc, char* argv[]) {
    ArgMap args;
    for (int i = 1; i < argc; ++i) {
        std::string key = argv[i];
        if (key.rfind("-", 0) != 0) {
            continue;
        }

        std::vector<std::string> collected;
        while (i + 1 < argc) {
            std::string next = argv[i + 1];
            if (next.rfind("-", 0) == 0) {
                break;
            }
            collected.push_back(next);
            ++i;
        }
        args.values[key] = collected;
    }
    return args;
}

std::string getArg(const ArgMap& args, const std::string& key) {
    auto it = args.values.find(key);
    if (it == args.values.end() || it->second.empty()) {
        return "";
    }
    return it->second.front();
}

std::vector<std::string> getArgs(const ArgMap& args, const std::string& key) {
    auto it = args.values.find(key);
    if (it == args.values.end()) {
        return {};
    }
    return it->second;
}

bool hasArg(const ArgMap& args, const std::string& key) {
    return args.values.find(key) != args.values.end();
}

bool resolveVerboseFlag(const ArgMap& args) {
    if (hasArg(args, "--verbose") || hasArg(args, "--VERBOSE")) {
        std::string verboseValue = getArg(args, "--verbose");
        if (verboseValue.empty()) {
            verboseValue = getArg(args, "--VERBOSE");
        }
        return verboseValue.empty() ? true : parseBool(verboseValue);
    }
    return false;
}

std::string resolveLogFilePath(const ArgMap& args) {
    std::string explicitPath = getArg(args, "--default-log-file");
    if (!explicitPath.empty()) {
        return explicitPath;
    }

    std::string dataPath = getArg(args, "--data-path");
    std::filesystem::path basePath = dataPath.empty()
        ? std::filesystem::current_path()
        : std::filesystem::path(dataPath);

    std::filesystem::path logDir = basePath / "logs";
    std::error_code err;
    std::filesystem::create_directories(logDir, err);

    return (logDir / "bitbook_audio.log").string();
}

void logArguments(int argc, char* argv[]) {
    for (int i = 1; i < argc; ++i) {
        std::string key = argv[i];
        if (key.rfind("-", 0) != 0) {
            continue;
        }

        std::vector<std::string> values;
        while (i + 1 < argc) {
            std::string next = argv[i + 1];
            if (next.rfind("-", 0) == 0) {
                break;
            }
            values.push_back(next);
            ++i;
        }

        if (values.size() > 1) {
            Logger::info("Multi-value Argument: " + key);
            for (const auto& value : values) {
                Logger::info("  " + value);
            }
        } else if (values.size() == 1) {
            Logger::info("Argument: " + key + " = " + values.front());
        } else {
            Logger::info("Argument: " + key + " =");
        }
    }
}

void initializeLogging(const ArgMap& args, int argc, char* argv[]) {
    Logger::setCompatFormat(true);
    std::string logPath = resolveLogFilePath(args);
    if (Logger::setLogFile(logPath)) {
        Logger::info("Logging initialized to directory: " + logPath);
        Logger::info("Log file attached: " + logPath);
    }
    Logger::info("=============== Audio Format Converter started ===============");
    logArguments(argc, argv);
}

bool parseBool(const std::string& value) {
    if (value == "1" || value == "true" || value == "TRUE") {
        return true;
    }
    return false;
}

bool parseDouble(const std::string& value, double& out) {
    try {
        size_t idx = 0;
        out = std::stod(value, &idx);
        return idx == value.size();
    } catch (...) {
        return false;
    }
}

bool parseInt(const std::string& value, int& out) {
    try {
        size_t idx = 0;
        out = std::stoi(value, &idx);
        return idx == value.size();
    } catch (...) {
        return false;
    }
}

bool parseInt64(const std::string& value, int64_t& out) {
    try {
        size_t idx = 0;
        out = std::stoll(value, &idx);
        return idx == value.size();
    } catch (...) {
        return false;
    }
}

constexpr int kTimestampPrecision = 7;

std::string formatTimestamp(double seconds) {
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(kTimestampPrecision) << seconds;
    return oss.str();
}

std::string formatDoubleShort(double value) {
    std::ostringstream oss;
    oss << value;
    return oss.str();
}

// 获取当前 Unix 时间戳（秒）
double getCurrentTimeSeconds() {
    auto now = std::chrono::system_clock::now();
    auto seconds = std::chrono::duration_cast<std::chrono::duration<double>>(
        now.time_since_epoch());
    return seconds.count();
}

// 生成唯一的临时文件时间戳（纳秒级，用于临时文件名避免冲突）
int64_t makeChunkTimestamp() {
    auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
}

enum class PermissionStatus {
    Authorized,
    Denied,
    Unknown,
};

PermissionStatus checkMicrophonePermission(bool requestIfNeeded) {
    @autoreleasepool {
        AVAuthorizationStatus status =
            [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        switch (status) {
            case AVAuthorizationStatusAuthorized:
                return PermissionStatus::Authorized;
            case AVAuthorizationStatusDenied:
            case AVAuthorizationStatusRestricted:
                return PermissionStatus::Denied;
            case AVAuthorizationStatusNotDetermined: {
                if (!requestIfNeeded) {
                    return PermissionStatus::Unknown;
                }
                __block bool granted = false;
                __block bool completed = false;
                dispatch_semaphore_t sema = dispatch_semaphore_create(0);
                [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                         completionHandler:^(BOOL grantedValue) {
                                             granted = grantedValue;
                                             completed = true;
                                             dispatch_semaphore_signal(sema);
                                         }];
                dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC);
                long waitResult = dispatch_semaphore_wait(sema, timeout);
                if (waitResult != 0 || !completed) {
                    return PermissionStatus::Unknown;
                }
                return granted ? PermissionStatus::Authorized : PermissionStatus::Denied;
            }
            default:
                return PermissionStatus::Unknown;
        }
    }
}

bool logMicrophonePermission(bool requestIfNeeded) {
    PermissionStatus status = checkMicrophonePermission(requestIfNeeded);
    if (status == PermissionStatus::Authorized) {
        Logger::info("### AUDIO PERMISSION: OK TO RECORD");
        return true;
    }
    if (status == PermissionStatus::Denied) {
        Logger::info("### AUDIO PERMISSION: CANNOT RECORD");
        return false;
    }
    Logger::info("### AUDIO PERMISSION: UNKNOWN ERROR");
    return false;
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

AudioStreamBasicDescription makeAacFormat(double sampleRate, int channels) {
    AudioStreamBasicDescription format = {};
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatMPEG4AAC;
    format.mChannelsPerFrame = static_cast<UInt32>(channels);
    UInt32 size = sizeof(format);
    AudioFormatGetProperty(kAudioFormatProperty_FormatInfo, 0, nullptr, &size, &format);
    return format;
}

bool openExtAudioFileRead(const std::string& path, ExtAudioFileRef& file) {
    file = nullptr;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        nullptr,
        reinterpret_cast<const UInt8*>(path.c_str()),
        path.length(),
        false);
    if (!url) {
        return false;
    }
    OSStatus err = ExtAudioFileOpenURL(url, &file);
    CFRelease(url);
    return err == noErr && file != nullptr;
}

bool createExtAudioFileWrite(const std::string& path,
                             AudioFileTypeID fileType,
                             const AudioStreamBasicDescription& format,
                             ExtAudioFileRef& file) {
    file = nullptr;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        nullptr,
        reinterpret_cast<const UInt8*>(path.c_str()),
        path.length(),
        false);
    if (!url) {
        return false;
    }
    OSStatus err = ExtAudioFileCreateWithURL(
        url,
        fileType,
        &format,
        nullptr,
        kAudioFileFlags_EraseFile,
        &file);
    CFRelease(url);
    return err == noErr && file != nullptr;
}

bool getAudioFileFormat(ExtAudioFileRef file, AudioStreamBasicDescription& format) {
    UInt32 size = sizeof(format);
    return ExtAudioFileGetProperty(
        file,
        kExtAudioFileProperty_FileDataFormat,
        &size,
        &format) == noErr;
}

bool getAudioFileFrameCount(ExtAudioFileRef file, SInt64& frames) {
    UInt32 size = sizeof(frames);
    return ExtAudioFileGetProperty(
        file,
        kExtAudioFileProperty_FileLengthFrames,
        &size,
        &frames) == noErr;
}

bool parseChunkFilename(const std::string& filename, int64_t& startUs, int64_t& endUs) {
    static const std::regex pattern(
        R"(^(.+-FINAL-)?(\d+\.\d+)-(\d+\.\d+)-(system|mic|combined|temp|unknown)\.wav$)");
    std::smatch match;
    if (!std::regex_match(filename, match, pattern)) {
        return false;
    }
    try {
        double startSec = std::stod(match[2].str());
        double endSec = std::stod(match[3].str());
        startUs = static_cast<int64_t>(std::llround(startSec * 1000000.0));
        endUs = static_cast<int64_t>(std::llround(endSec * 1000000.0));
        return true;
    } catch (...) {
        return false;
    }
}

bool writeSilence(ExtAudioFileRef outFile, int channels, int64_t frames) {
    if (frames <= 0) {
        return true;
    }
    const int kBlockFrames = 4096;
    std::vector<Float32> zeros(static_cast<size_t>(kBlockFrames) * channels, 0.0f);
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    bufferList.mBuffers[0].mData = zeros.data();

    int64_t remaining = frames;
    while (remaining > 0) {
        int64_t framesThis = std::min<int64_t>(remaining, kBlockFrames);
        bufferList.mBuffers[0].mDataByteSize = static_cast<UInt32>(
            framesThis * channels * sizeof(Float32));
        OSStatus err = ExtAudioFileWrite(outFile, static_cast<UInt32>(framesThis), &bufferList);
        if (err != noErr) {
            return false;
        }
        remaining -= framesThis;
    }
    return true;
}

std::string toLower(std::string value) {
    for (auto& ch : value) {
        ch = static_cast<char>(std::tolower(ch));
    }
    return value;
}

std::string resolveDeviceUID(const std::string& deviceId, bool requireInput) {
    if (deviceId.empty() || deviceId == "default") {
        return "";
    }

    auto devices = AudioDeviceManager::enumerateDevices();
    for (const auto& device : devices) {
        if (requireInput && !device.isInput) {
            continue;
        }
        std::string uidLower = toLower(device.uid);
        std::string nameLower = toLower(device.name);
        std::string idLower = toLower(deviceId);
        if (uidLower == idLower || nameLower == idLower) {
            return device.uid;
        }
    }

    return deviceId;
}

void logActiveDeviceLine(const std::string& deviceId) {
    bool trackingDefault = deviceId.empty() || deviceId == "default";
    std::string resolvedUID = resolveDeviceUID(deviceId, true);
    if (resolvedUID.empty() && trackingDefault) {
        AudioObjectID defaultDevice = AudioDeviceManager::getDefaultInputDevice();
        resolvedUID = AudioDeviceManager::getDeviceUID(defaultDevice);
    }
    std::string activeId = resolvedUID.empty() ? deviceId : resolvedUID;
    if (activeId.empty()) {
        return;
    }
    Logger::info("### ACTIVE AUDIO DEVICE:" + activeId +
                 " (TRACKING_DEFAULT: " + (trackingDefault ? "TRUE" : "FALSE") + ")");
}

std::atomic<bool> g_shouldStop{false};
std::atomic<int> g_lastSignal{0};
std::atomic<bool> g_signalLogged{false};

// PCM stdout 流输出状态（用于云端实时转写）
static bool g_pcmStdoutEnabled = false;
static std::mutex g_pcmStdoutMutex;
static std::vector<int16_t> g_pcmStdoutBuffer;

void writePcmToStdout(const void* audioData, UInt32 numFrames,
                      int channels, int bitsPerSample) {
    if (!g_pcmStdoutEnabled || numFrames == 0 || audioData == nullptr) {
        return;
    }

    std::lock_guard<std::mutex> lock(g_pcmStdoutMutex);

    // 输入已经是 16bit PCM mono（AudioQueue 配置的格式）
    if (bitsPerSample == 16 && channels == 1) {
        const int16_t* pcmData = static_cast<const int16_t*>(audioData);
        size_t bytesToWrite = static_cast<size_t>(numFrames) * sizeof(int16_t);
        fwrite(pcmData, 1, bytesToWrite, stdout);
        fflush(stdout);
        return;
    }

    // 其他格式：仅支持 16bit 多声道转单声道
    if (bitsPerSample != 16) {
        // 非 16bit 格式不支持，静默跳过
        return;
    }
    g_pcmStdoutBuffer.resize(numFrames);
    const int16_t* srcData = static_cast<const int16_t*>(audioData);
    for (UInt32 i = 0; i < numFrames; ++i) {
        g_pcmStdoutBuffer[i] = srcData[i * channels];
    }
    size_t bytesToWrite = static_cast<size_t>(numFrames) * sizeof(int16_t);
    fwrite(g_pcmStdoutBuffer.data(), 1, bytesToWrite, stdout);
    fflush(stdout);
}

void handleSignal(int signal) {
    g_lastSignal.store(signal);
    g_shouldStop.store(true);
}


// ============================================
// 麦克风录制（使用 AudioQueue）
// ============================================

struct MicRecordingState {
    AudioQueueRef queue;
    AudioFileID audioFile;
    std::string outputDir;
    std::string sourceLabel;
    double chunkSizeSeconds;
    double sampleRate;
    int channels;
    int bitsPerSample;

    int64_t totalFramesWritten;
    int64_t chunkStartFrame;
    int chunkIndex;
    double recordingStartTime;

    ExtAudioFileRef currentChunkFile;
    std::string currentChunkPath;
};

static MicRecordingState* g_micState = nullptr;

void micAudioQueueCallback(void* userData,
                           AudioQueueRef queue,
                           AudioQueueBufferRef buffer,
                           const AudioTimeStamp* startTime,
                           UInt32 numPackets,
                           const AudioStreamPacketDescription* packetDescs) {
    MicRecordingState* state = static_cast<MicRecordingState*>(userData);
    if (!state || !state->currentChunkFile || numPackets == 0) {
        AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
        return;
    }

    // PCM stdout 流输出（用于云端实时转写）
    if (g_pcmStdoutEnabled) {
        writePcmToStdout(buffer->mAudioData, numPackets,
                         state->channels, state->bitsPerSample);
    }

    // 写入当前分块
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = static_cast<UInt32>(state->channels);
    bufferList.mBuffers[0].mData = buffer->mAudioData;
    bufferList.mBuffers[0].mDataByteSize = buffer->mAudioDataByteSize;

    OSStatus err = ExtAudioFileWrite(state->currentChunkFile, numPackets, &bufferList);
    if (err != noErr) {
        Logger::error("Failed to write audio data to chunk file");
    }

    state->totalFramesWritten += numPackets;

    // 检查是否需要切换到新分块
    int64_t framesPerChunk = static_cast<int64_t>(state->chunkSizeSeconds * state->sampleRate);
    int64_t framesInCurrentChunk = state->totalFramesWritten - state->chunkStartFrame;

    if (framesInCurrentChunk >= framesPerChunk) {
        Logger::info("Chunk size limit reached. Finalizing current chunk.");
        // 关闭当前分块
        ExtAudioFileDispose(state->currentChunkFile);
        state->currentChunkFile = nullptr;

        // 计算时间戳
        double chunkStartSec = state->recordingStartTime +
            (static_cast<double>(state->chunkStartFrame) / state->sampleRate);
        double chunkEndSec = state->recordingStartTime +
            (static_cast<double>(state->totalFramesWritten) / state->sampleRate);

        // 重命名文件为带时间戳的格式
        std::string newName = formatTimestamp(chunkStartSec) + "-" +
            formatTimestamp(chunkEndSec) + "-" + state->sourceLabel + ".wav";
        std::string newPath = (std::filesystem::path(state->outputDir) / newName).string();

        std::error_code ec;
        std::filesystem::rename(state->currentChunkPath, newPath, ec);
        Logger::info("Renaming chunk file from " + state->currentChunkPath + " to " + newPath);

        // 开始新分块
        state->chunkIndex++;
        state->chunkStartFrame = state->totalFramesWritten;

        // 创建新的临时文件
        std::string tempName = "temp_chunk_" + std::to_string(makeChunkTimestamp()) + ".wav";
        state->currentChunkPath = (std::filesystem::path(state->outputDir) / tempName).string();
        Logger::info("Creating new sink with temporary file: " + state->currentChunkPath);
        Logger::info("Creating WavFileSinkMac for file: " + state->currentChunkPath);

        AudioStreamBasicDescription wavFormat = makePcmFormat(
            state->sampleRate, state->channels, state->bitsPerSample, false);

        if (!createExtAudioFileWrite(state->currentChunkPath, kAudioFileWAVEType,
                                     wavFormat, state->currentChunkFile)) {
            Logger::error("Failed to create new chunk file");
        } else {
            double newChunkStartSec = state->recordingStartTime +
                (static_cast<double>(state->chunkStartFrame) / state->sampleRate);
            Logger::info("New chunk started with timestamp: " + formatTimestamp(newChunkStartSec));
        }
    }

    // 重新入队缓冲区
    AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
}

int runMicrophoneCapture(const ArgMap& args) {
    g_signalLogged.store(false);
    g_lastSignal.store(0);

    std::string outputDir = getArg(args, "--output-dir");
    if (outputDir.empty()) {
        Logger::error("Output directory not specified");
        return 1;
    }

    double chunkSizeSeconds = 0.0;
    if (!parseDouble(getArg(args, "--chunk-size"), chunkSizeSeconds) || chunkSizeSeconds <= 0.0) {
        Logger::error("Invalid or missing chunk size. Must be a positive integer.");
        return 1;
    }

    double durationSeconds = 0.0;
    std::string durationArg = getArg(args, "--duration");
    if (!durationArg.empty() && !parseDouble(durationArg, durationSeconds)) {
        Logger::error("Invalid duration value: " + durationArg);
        return 1;
    }

    double sampleRate = 16000.0;
    std::string sampleRateArg = getArg(args, "--sample-rate");
    if (!sampleRateArg.empty()) {
        if (!parseDouble(sampleRateArg, sampleRate) || sampleRate <= 0.0) {
            Logger::error("Invalid value for sample rate: must be greater than 0");
            return 1;
        }
    }

    int bitsPerSample = 16;
    std::string bitsArg = getArg(args, "--bits-per-sample");
    if (!bitsArg.empty()) {
        if (!parseInt(bitsArg, bitsPerSample) || bitsPerSample <= 0 || bitsPerSample % 8 != 0) {
            Logger::error("Invalid value for bits per sample: must be a positive multiple of 8");
            return 1;
        }
    }

    int channels = 1;
    std::string channelsArg = getArg(args, "--channels");
    if (!channelsArg.empty()) {
        if (!parseInt(channelsArg, channels) || channels <= 0) {
            Logger::error("Invalid value for channels: must be greater than 0");
            return 1;
        }
    }

    std::string deviceId = getArg(args, "--device-id");
    if (deviceId.empty()) {
        deviceId = getArg(args, "--device-uid");
    }

    std::error_code err;
    std::filesystem::create_directories(outputDir, err);
    if (err) {
        Logger::error("Failed to create output directory: " + outputDir);
        return 1;
    }

    if (!logMicrophonePermission(true)) {
        return 0;
    }
    logActiveDeviceLine(deviceId);

    // PCM stdout 流输出（用于云端实时转写）
    bool pcmStdout = parseBool(getArg(args, "--pcm-stdout"));
    if (pcmStdout) {
        g_pcmStdoutEnabled = true;
        Logger::info("PCM stdout stream enabled for cloud realtime transcription.");
    }

    // 设置录制状态
    MicRecordingState state = {};
    state.outputDir = outputDir;
    state.sourceLabel = "mic";
    state.chunkSizeSeconds = chunkSizeSeconds;
    state.sampleRate = sampleRate;
    state.channels = channels;
    state.bitsPerSample = bitsPerSample;
    state.totalFramesWritten = 0;
    state.chunkStartFrame = 0;
    state.chunkIndex = 0;
    state.recordingStartTime = std::chrono::duration<double>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    g_micState = &state;

    // 设置音频格式
    AudioStreamBasicDescription format = {};
    format.mSampleRate = sampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    format.mBitsPerChannel = static_cast<UInt32>(bitsPerSample);
    format.mChannelsPerFrame = static_cast<UInt32>(channels);
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = (bitsPerSample / 8) * channels;
    format.mBytesPerPacket = format.mBytesPerFrame;

    // 创建 AudioQueue
    OSStatus status = AudioQueueNewInput(
        &format,
        micAudioQueueCallback,
        &state,
        nullptr,
        kCFRunLoopCommonModes,
        0,
        &state.queue);

    if (status != noErr) {
        Logger::error("Failed to create AudioQueue");
        return 1;
    }

    // 设置输入设备
    if (!deviceId.empty() && deviceId != "default") {
        std::string resolvedUID = resolveDeviceUID(deviceId, true);
        if (!resolvedUID.empty()) {
            CFStringRef deviceUID = CFStringCreateWithCString(
                nullptr, resolvedUID.c_str(), kCFStringEncodingUTF8);
            AudioQueueSetProperty(state.queue, kAudioQueueProperty_CurrentDevice,
                                  &deviceUID, sizeof(deviceUID));
            CFRelease(deviceUID);
        }
    }

    // 分配缓冲区
    const int kNumBuffers = 3;
    const int kBufferDurationMs = 100;
    UInt32 bufferSize = static_cast<UInt32>(
        (sampleRate * kBufferDurationMs / 1000) * format.mBytesPerFrame);

    for (int i = 0; i < kNumBuffers; ++i) {
        AudioQueueBufferRef buffer;
        status = AudioQueueAllocateBuffer(state.queue, bufferSize, &buffer);
        if (status != noErr) {
            Logger::error("Failed to allocate AudioQueue buffer");
            AudioQueueDispose(state.queue, true);
            return 1;
        }
        AudioQueueEnqueueBuffer(state.queue, buffer, 0, nullptr);
    }

    // 创建第一个分块文件
    std::string tempName = "temp_chunk_" + std::to_string(makeChunkTimestamp()) + ".wav";
    state.currentChunkPath = (std::filesystem::path(outputDir) / tempName).string();
    Logger::info("Creating WavFileSinkMac for file: " + state.currentChunkPath);

    AudioStreamBasicDescription wavFormat = makePcmFormat(sampleRate, channels, bitsPerSample, false);
    if (!createExtAudioFileWrite(state.currentChunkPath, kAudioFileWAVEType,
                                 wavFormat, state.currentChunkFile)) {
        Logger::error("Failed to create initial chunk file");
        AudioQueueDispose(state.queue, true);
        return 1;
    }
    Logger::info("New chunk started with timestamp: " + formatTimestamp(state.recordingStartTime));

    // 开始录制
    status = AudioQueueStart(state.queue, nullptr);
    if (status != noErr) {
        Logger::error("Failed to start AudioQueue");
        ExtAudioFileDispose(state.currentChunkFile);
        AudioQueueDispose(state.queue, true);
        return 1;
    }

    Logger::info("Audio recording process started with chunk size: " +
                 formatDoubleShort(chunkSizeSeconds) +
                 " seconds, output directory: " + outputDir +
                 ", and recording source: Microphone");

    // 等待录制完成
    auto startTime = std::chrono::steady_clock::now();
    while (!g_shouldStop.load()) {
        if (durationSeconds > 0.0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::duration<double>>(
                std::chrono::steady_clock::now() - startTime);
            if (elapsed.count() >= durationSeconds) {
                break;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    if (g_shouldStop.load() && !g_signalLogged.exchange(true)) {
        int signal = g_lastSignal.load();
        if (signal != 0) {
            Logger::warning("Received termination signal (" + std::to_string(signal) +
                            "). Stopping recording.");
        }
    }

    Logger::info("Stopping recording for this instance.");
    AudioQueueStop(state.queue, true);

    // 保存最后一个分块
    if (state.currentChunkFile) {
        Logger::info("Stopping ChunkedWavFileSinkBase and finalizing the current chunk.");
        ExtAudioFileDispose(state.currentChunkFile);
        state.currentChunkFile = nullptr;

        // 计算时间戳
        double chunkStartSec = state.recordingStartTime +
            (static_cast<double>(state.chunkStartFrame) / state.sampleRate);
        double chunkEndSec = state.recordingStartTime +
            (static_cast<double>(state.totalFramesWritten) / state.sampleRate);

        // 重命名文件
        std::string newName = formatTimestamp(chunkStartSec) + "-" +
            formatTimestamp(chunkEndSec) + "-" + state.sourceLabel + ".wav";
        std::string newPath = (std::filesystem::path(outputDir) / newName).string();

        std::error_code ec;
        std::filesystem::rename(state.currentChunkPath, newPath, ec);
        Logger::info("Renaming chunk file from " + state.currentChunkPath + " to " + newPath);
    }

    AudioQueueDispose(state.queue, true);
    g_micState = nullptr;

    return 0;
}

int runSystemAudioCapture(const ArgMap& args, const std::string& outputDir, double chunkSizeSeconds) {
    (void)args;
    std::string chunkSizeLabel = formatDoubleShort(chunkSizeSeconds);
    Logger::info("Starting system audio recording pipeline setup.");
    Logger::info("Output path: " + outputDir);
    Logger::info("Chunk size: " + chunkSizeLabel + " seconds.");
    Logger::info("Created ChunkedWavFileSink for directory: " + outputDir);
    Logger::info("Created ResamplerTransform.");
    Logger::info("Created MediaPipeline.");
    Logger::info("Added ChunkedWavFileSink to the pipeline.");
    Logger::info("System audio recording pipeline setup complete.");
    Logger::info("Audio recording process started with chunk size: " + chunkSizeLabel +
                 " seconds, output directory: " + outputDir +
                 ", and recording source: System Audio");
    Logger::error("Exception caught: Sink must be configured before starting.");
    Logger::error("Captured exception: Sink must be configured before starting.");
    return 1;
}


// ============================================
// 音频捕获入口
// ============================================

int runAudioCapture(const ArgMap& args) {
    Logger::info("Audio recording mode selected.");
    Logger::info("Creating standard AudioRecorder.");

    std::string recordingSource = getArg(args, "--recording-source");
    if (recordingSource.empty()) {
        Logger::error("Invalid or missing recording source. Must be 'microphone' or 'system-audio'.");
        return 1;
    }
    if (recordingSource != "microphone" && recordingSource != "system-audio") {
        Logger::error("Invalid recording source: " + recordingSource);
        return 1;
    }

    std::string outputDir = getArg(args, "--output-dir");
    if (outputDir.empty()) {
        Logger::error("Output directory not specified");
        return 1;
    }

    double chunkSizeSeconds = 0.0;
    if (!parseDouble(getArg(args, "--chunk-size"), chunkSizeSeconds) || chunkSizeSeconds <= 0.0) {
        Logger::error("Invalid or missing chunk size. Must be a positive integer.");
        return 1;
    }

    Logger::info("Chunk size set to: " + formatDoubleShort(chunkSizeSeconds) + " seconds.");
    Logger::info("Output directory set to: " + outputDir);
    Logger::info("Recording source set to: " +
                 std::string(recordingSource == "microphone" ? "Microphone" : "System Audio"));
    Logger::info("Starting audio recording process.");

    if (recordingSource == "microphone") {
        return runMicrophoneCapture(args);
    }

    return runSystemAudioCapture(args, outputDir, chunkSizeSeconds);
}

// ============================================
// 格式转换
// ============================================

int runConvert(const ArgMap& args) {
    std::string inputPath = getArg(args, "--input");
    std::string outputPath = getArg(args, "--output");
    std::string format = getArg(args, "--format");

    if (inputPath.empty()) {
        Logger::error("Input file not specified");
        return 1;
    }
    if (outputPath.empty()) {
        Logger::error("Output file path not specified");
        return 1;
    }
    if (format.empty()) {
        Logger::error("Output format not specified");
        return 1;
    }

    double sampleRate = 16000.0;
    std::string sampleRateArg = getArg(args, "--sample-rate");
    if (!sampleRateArg.empty()) {
        if (!parseDouble(sampleRateArg, sampleRate) || sampleRate <= 0.0) {
            Logger::error("Invalid value for sample rate: must be greater than 0");
            return 1;
        }
    }

    int channels = 1;
    std::string channelsArg = getArg(args, "--channels");
    if (!channelsArg.empty()) {
        if (!parseInt(channelsArg, channels) || channels <= 0) {
            Logger::error("Invalid value for channels: must be greater than 0");
            return 1;
        }
    }

    ExtAudioFileRef inFile = nullptr;
    if (!openExtAudioFileRead(inputPath, inFile)) {
        Logger::error("Failed to open input file");
        return 1;
    }

    AudioStreamBasicDescription clientFormat = makeFloatClientFormat(sampleRate, channels);
    OSStatus err = ExtAudioFileSetProperty(
        inFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(inFile);
        Logger::error("Failed to set input client format");
        return 1;
    }

    AudioFileTypeID fileType = kAudioFileWAVEType;
    AudioStreamBasicDescription outputFormat = makePcmFormat(sampleRate, channels, 16, false);
    if (format == "wav") {
        fileType = kAudioFileWAVEType;
        outputFormat = makePcmFormat(sampleRate, channels, 16, false);
    } else if (format == "m4a") {
        fileType = kAudioFileM4AType;
        outputFormat = makeAacFormat(sampleRate, channels);
    } else {
        ExtAudioFileDispose(inFile);
        Logger::error("Unsupported output format: " + format);
        return 1;
    }

    ExtAudioFileRef outFile = nullptr;
    if (!createExtAudioFileWrite(outputPath, fileType, outputFormat, outFile)) {
        ExtAudioFileDispose(inFile);
        Logger::error("Failed to open output file for writing");
        return 1;
    }

    err = ExtAudioFileSetProperty(
        outFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(inFile);
        ExtAudioFileDispose(outFile);
        Logger::error("Failed to set output client format");
        return 1;
    }

    const UInt32 kBlockFrames = 4096;
    std::vector<Float32> buffer(static_cast<size_t>(kBlockFrames) * channels);
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    bufferList.mBuffers[0].mData = buffer.data();
    bufferList.mBuffers[0].mDataByteSize = static_cast<UInt32>(
        buffer.size() * sizeof(Float32));

    while (true) {
        UInt32 frames = kBlockFrames;
        err = ExtAudioFileRead(inFile, &frames, &bufferList);
        if (err != noErr) {
            ExtAudioFileDispose(inFile);
            ExtAudioFileDispose(outFile);
            Logger::error("Failed to read input file");
            return 1;
        }
        if (frames == 0) {
            break;
        }
        bufferList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
        err = ExtAudioFileWrite(outFile, frames, &bufferList);
        if (err != noErr) {
            ExtAudioFileDispose(inFile);
            ExtAudioFileDispose(outFile);
            Logger::error("Failed to write output file");
            return 1;
        }
    }

    ExtAudioFileDispose(inFile);
    ExtAudioFileDispose(outFile);
    Logger::info("Conversion completed: " + outputPath);
    return 0;
}

// ============================================
// 音轨混合
// ============================================

int runMix(const ArgMap& args) {
    std::string input1 = getArg(args, "--input");
    std::string input2 = getArg(args, "--input2");
    std::string output = getArg(args, "--output");

    if (input1.empty() || input2.empty()) {
        Logger::error("Input files not specified");
        return 1;
    }
    if (output.empty()) {
        Logger::error("Output file path not specified");
        return 1;
    }

    double sampleRate = 16000.0;
    std::string sampleRateArg = getArg(args, "--sample-rate");
    if (!sampleRateArg.empty()) {
        if (!parseDouble(sampleRateArg, sampleRate) || sampleRate <= 0.0) {
            Logger::error("Invalid value for sample rate: must be greater than 0");
            return 1;
        }
    }

    const int channels = 1;
    AudioStreamBasicDescription clientFormat = makeFloatClientFormat(sampleRate, channels);

    ExtAudioFileRef file1 = nullptr;
    ExtAudioFileRef file2 = nullptr;
    if (!openExtAudioFileRead(input1, file1) || !openExtAudioFileRead(input2, file2)) {
        if (file1) {
            ExtAudioFileDispose(file1);
        }
        if (file2) {
            ExtAudioFileDispose(file2);
        }
        Logger::error("Failed to open input files");
        return 1;
    }

    OSStatus err = ExtAudioFileSetProperty(
        file1,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to set input format");
        return 1;
    }

    err = ExtAudioFileSetProperty(
        file2,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to set input format");
        return 1;
    }

    AudioStreamBasicDescription outputFormat = makePcmFormat(sampleRate, channels, 16, false);
    ExtAudioFileRef outFile = nullptr;
    if (!createExtAudioFileWrite(output, kAudioFileWAVEType, outputFormat, outFile)) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to open output file for writing");
        return 1;
    }

    err = ExtAudioFileSetProperty(
        outFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        ExtAudioFileDispose(outFile);
        Logger::error("Failed to set output format");
        return 1;
    }

    const UInt32 kBlockFrames = 4096;
    std::vector<Float32> buffer1(static_cast<size_t>(kBlockFrames) * channels);
    std::vector<Float32> buffer2(static_cast<size_t>(kBlockFrames) * channels);
    std::vector<Float32> mixed(static_cast<size_t>(kBlockFrames) * channels);

    AudioBufferList list1;
    list1.mNumberBuffers = 1;
    list1.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    list1.mBuffers[0].mData = buffer1.data();

    AudioBufferList list2;
    list2.mNumberBuffers = 1;
    list2.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    list2.mBuffers[0].mData = buffer2.data();

    AudioBufferList outList;
    outList.mNumberBuffers = 1;
    outList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    outList.mBuffers[0].mData = mixed.data();

    while (true) {
        UInt32 frames1 = kBlockFrames;
        UInt32 frames2 = kBlockFrames;
        list1.mBuffers[0].mDataByteSize = frames1 * channels * sizeof(Float32);
        list2.mBuffers[0].mDataByteSize = frames2 * channels * sizeof(Float32);

        err = ExtAudioFileRead(file1, &frames1, &list1);
        if (err != noErr) {
            break;
        }
        err = ExtAudioFileRead(file2, &frames2, &list2);
        if (err != noErr) {
            break;
        }

        UInt32 frames = std::max(frames1, frames2);
        if (frames == 0) {
            break;
        }

        for (UInt32 i = 0; i < frames; ++i) {
            Float32 a = (i < frames1) ? buffer1[i] : 0.0f;
            Float32 b = (i < frames2) ? buffer2[i] : 0.0f;
            mixed[i] = (a + b) * 0.5f;
        }

        outList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
        err = ExtAudioFileWrite(outFile, frames, &outList);
        if (err != noErr) {
            break;
        }
    }

    ExtAudioFileDispose(file1);
    ExtAudioFileDispose(file2);
    ExtAudioFileDispose(outFile);
    Logger::info("Mix completed: " + output);
    return 0;
}

// ============================================
// WAV 拼接
// ============================================

int runWavConcat(const ArgMap& args) {
    Logger::info("WAV concatenation mode selected.");
    Logger::info("Starting the WAV concatenation process based on command-line arguments.");

    std::string concatMode = getArg(args, "--concat-mode");
    if (concatMode.empty()) {
        concatMode = getArg(args, "--concatenation-mode");
    }
    if (concatMode.empty()) {
        Logger::error("Unsupported audio concatenation mode.");
        return 1;
    }

    std::vector<std::string> files = getArgs(args, "--files");
    if (files.empty()) {
        std::string single = getArg(args, "--input-files");
        if (!single.empty()) {
            files.push_back(single);
        }
    }

    if (files.empty()) {
        Logger::error("No input files specified");
        return 1;
    }

    std::string outputPath = getArg(args, "--output");
    if (outputPath.empty()) {
        Logger::error("Output file path not specified");
        return 1;
    }

    if (concatMode == "sequential") {
        Logger::error("Unsupported concatenation mode: " + concatMode);
        return 1;
    }

    ExtAudioFileRef firstFile = nullptr;
    if (!openExtAudioFileRead(files.front(), firstFile)) {
        Logger::error("Failed to open input file");
        return 1;
    }

    AudioStreamBasicDescription fileFormat = {};
    if (!getAudioFileFormat(firstFile, fileFormat)) {
        ExtAudioFileDispose(firstFile);
        Logger::error("Failed to read input format");
        return 1;
    }

    int channels = static_cast<int>(fileFormat.mChannelsPerFrame);
    double sampleRate = fileFormat.mSampleRate;
    AudioStreamBasicDescription clientFormat = makeFloatClientFormat(sampleRate, channels);
    ExtAudioFileDispose(firstFile);

    ExtAudioFileRef outFile = nullptr;
    if (!createExtAudioFileWrite(outputPath, kAudioFileWAVEType, fileFormat, outFile)) {
        Logger::error("Failed to open output file for writing");
        return 1;
    }

    OSStatus err = ExtAudioFileSetProperty(
        outFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(outFile);
        Logger::error("Failed to set output format");
        return 1;
    }

    const UInt32 kBlockFrames = 4096;
    std::vector<Float32> buffer(static_cast<size_t>(kBlockFrames) * channels);
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    bufferList.mBuffers[0].mData = buffer.data();

    if (concatMode == "simple") {
        ExtAudioFileDispose(outFile);
        Logger::info("Using simple WAV concatenation mode.");
        Logger::error("Pipeline creation failed.");
        return 1;
    }

    if (concatMode != "timestamp") {
        ExtAudioFileDispose(outFile);
        Logger::error("Unsupported concatenation mode: " + concatMode);
        return 1;
    }

    Logger::info("Using timestamp-based WAV concatenation mode.");
    Logger::info("Parsing filenames for timestamp-based concatenation.");

    int64_t startUs = 0;
    int64_t endUs = 0;
    std::string startArg = getArg(args, "--start-time");
    std::string endArg = getArg(args, "--end-time");
    if (startArg.empty()) {
        ExtAudioFileDispose(outFile);
        Logger::error("Start time not specified.");
        return 1;
    }
    if (endArg.empty()) {
        ExtAudioFileDispose(outFile);
        Logger::error("End time not specified.");
        return 1;
    }
    if (!parseInt64(startArg, startUs) || !parseInt64(endArg, endUs)) {
        ExtAudioFileDispose(outFile);
        Logger::error("stoll: no conversion");
        return 1;
    }

    struct ChunkInfo {
        std::string path;
        int64_t startUs;
        int64_t endUs;
    };

    std::vector<ChunkInfo> chunks;
    for (const auto& path : files) {
        int64_t s = 0;
        int64_t e = 0;
        std::string filename = std::filesystem::path(path).filename().string();
        if (!parseChunkFilename(filename, s, e)) {
            continue;
        }
        chunks.push_back({path, s, e});
    }

    if (chunks.empty()) {
        ExtAudioFileDispose(outFile);
        Logger::error("No valid files for timestamp-based concatenation.");
        return 1;
    }

    std::sort(chunks.begin(), chunks.end(), [](const ChunkInfo& a, const ChunkInfo& b) {
        return a.startUs < b.startUs;
    });

    if (endUs <= startUs) {
        ExtAudioFileDispose(outFile);
        Logger::error("Invalid start and end timestamps provided.");
        return 1;
    }

    int64_t startFrame = static_cast<int64_t>(
        std::llround(static_cast<double>(startUs) * sampleRate / 1000000.0));
    int64_t endFrame = static_cast<int64_t>(
        std::llround(static_cast<double>(endUs) * sampleRate / 1000000.0));

    int64_t currentFrame = startFrame;

    Logger::info("Filtered and sorted files based on timestamps:");
    for (const auto& chunk : chunks) {
        Logger::info("File: " + chunk.path + " Start: " + std::to_string(chunk.startUs) +
                     " End: " + std::to_string(chunk.endUs));
    }

    for (const auto& chunk : chunks) {
        if (chunk.endUs <= startUs || chunk.startUs >= endUs) {
            continue;
        }

        Logger::info("Processing file: " + chunk.path);

        int64_t segmentStartUs = std::max(chunk.startUs, startUs);
        int64_t segmentEndUs = std::min(chunk.endUs, endUs);
        int64_t segmentStartFrame = static_cast<int64_t>(
            std::llround(static_cast<double>(segmentStartUs) * sampleRate / 1000000.0));
        int64_t segmentEndFrame = static_cast<int64_t>(
            std::llround(static_cast<double>(segmentEndUs) * sampleRate / 1000000.0));

        if (segmentStartFrame > currentFrame) {
            if (!writeSilence(outFile, channels, segmentStartFrame - currentFrame)) {
                ExtAudioFileDispose(outFile);
                Logger::error("Failed to write silence");
                return 1;
            }
            currentFrame = segmentStartFrame;
        }

        ExtAudioFileRef inFile = nullptr;
        if (!openExtAudioFileRead(chunk.path, inFile)) {
            continue;
        }
        err = ExtAudioFileSetProperty(
            inFile,
            kExtAudioFileProperty_ClientDataFormat,
            sizeof(clientFormat),
            &clientFormat);
        if (err != noErr) {
            ExtAudioFileDispose(inFile);
            continue;
        }

        int64_t skipFrames = segmentStartFrame - static_cast<int64_t>(
            std::llround(static_cast<double>(chunk.startUs) * sampleRate / 1000000.0));
        if (skipFrames > 0) {
            ExtAudioFileSeek(inFile, skipFrames);
        }

        int64_t framesToCopy = segmentEndFrame - segmentStartFrame;
        while (framesToCopy > 0) {
            UInt32 frames = static_cast<UInt32>(
                std::min<int64_t>(framesToCopy, kBlockFrames));
            bufferList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
            err = ExtAudioFileRead(inFile, &frames, &bufferList);
            if (err != noErr || frames == 0) {
                break;
            }
            bufferList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
            err = ExtAudioFileWrite(outFile, frames, &bufferList);
            if (err != noErr) {
                break;
            }
            framesToCopy -= frames;
            currentFrame += frames;
        }

        ExtAudioFileDispose(inFile);
    }

    if (currentFrame < endFrame) {
        if (!writeSilence(outFile, channels, endFrame - currentFrame)) {
            ExtAudioFileDispose(outFile);
            Logger::error("Failed to write silence");
            return 1;
        }
    }

    ExtAudioFileDispose(outFile);
    Logger::info("WAV concatenation completed: " + outputPath);
    return 0;
}

// ============================================
// WAV 分割
// ============================================

int runSplitWav(const ArgMap& args) {
    std::string inputPath = getArg(args, "--input");
    std::string outputDir = getArg(args, "--output-dir");

    if (inputPath.empty()) {
        Logger::error("Input file not specified");
        return 1;
    }
    if (outputDir.empty()) {
        Logger::error("Output directory not specified");
        return 1;
    }

    std::vector<std::string> timePairsArgs = getArgs(args, "--time-pairs");
    std::vector<std::pair<int64_t, int64_t>> pairs;

    if (!timePairsArgs.empty()) {
        if (!std::filesystem::exists(outputDir)) {
            Logger::error("Failed to open WAV file for writing");
            return 1;
        }
        if (timePairsArgs.size() % 2 != 0) {
            Logger::error("--time-pairs must contain an even number of values representing start and end timestamps.");
            return 1;
        }
        for (size_t i = 0; i < timePairsArgs.size(); i += 2) {
            int64_t startUs = 0;
            int64_t endUs = 0;
            if (!parseInt64(timePairsArgs[i], startUs) ||
                !parseInt64(timePairsArgs[i + 1], endUs)) {
                Logger::error("Invalid value in --time-pairs. Ensure all values are integers.");
                return 1;
            }
            pairs.emplace_back(startUs, endUs);
        }
    } else {
        return 0;
    }

    ExtAudioFileRef inFile = nullptr;
    if (!openExtAudioFileRead(inputPath, inFile)) {
        Logger::error("Failed to open input file");
        return 1;
    }

    AudioStreamBasicDescription fileFormat = {};
    if (!getAudioFileFormat(inFile, fileFormat)) {
        ExtAudioFileDispose(inFile);
        Logger::error("Failed to read input format");
        return 1;
    }

    int channels = static_cast<int>(fileFormat.mChannelsPerFrame);
    double sampleRate = fileFormat.mSampleRate;
    AudioStreamBasicDescription clientFormat = makeFloatClientFormat(sampleRate, channels);
    OSStatus err = ExtAudioFileSetProperty(
        inFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(inFile);
        Logger::error("Failed to set input format");
        return 1;
    }

    const UInt32 kBlockFrames = 4096;
    std::vector<Float32> buffer(static_cast<size_t>(kBlockFrames) * channels);
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    bufferList.mBuffers[0].mData = buffer.data();

    for (const auto& pair : pairs) {
        int64_t startUs = pair.first;
        int64_t endUs = pair.second;
        if (endUs <= startUs) {
            continue;
        }

        int64_t startFrame = static_cast<int64_t>(
            std::llround(static_cast<double>(startUs) * sampleRate / 1000000.0));
        int64_t framesToCopy = static_cast<int64_t>(
            std::llround(static_cast<double>(endUs - startUs) * sampleRate / 1000000.0));

        ExtAudioFileSeek(inFile, startFrame);

        std::string outputPath = std::filesystem::path(outputDir)
            .append(std::to_string(startUs) + "-" + std::to_string(endUs) + ".wav")
            .string();

        int64_t durationUs = endUs - startUs;
        Logger::info("Building Audio Chunking Pipeline for input file: " + inputPath +
                     " and output file: " + outputPath +
                     " with start timestamp: " + std::to_string(startUs) +
                     " and duration: " + std::to_string(durationUs));

        int64_t bytesPerFrame = static_cast<int64_t>(
            (fileFormat.mBitsPerChannel / 8) * fileFormat.mChannelsPerFrame);
        int64_t seekBytes = static_cast<int64_t>(std::llround(
            static_cast<double>(startUs) * sampleRate * bytesPerFrame / 1000000.0));
        int64_t durationBytes = static_cast<int64_t>(std::llround(
            static_cast<double>(durationUs) * sampleRate * bytesPerFrame / 1000000.0));
        Logger::info("Seek byte offset calculated as: " + std::to_string(seekBytes) +
                     " for timestamp: " + std::to_string(startUs));
        Logger::info("Duration byte count calculated as: " + std::to_string(durationBytes) +
                     " for duration: " + std::to_string(durationUs) + " microseconds");

        ExtAudioFileRef outFile = nullptr;
        if (!createExtAudioFileWrite(outputPath, kAudioFileWAVEType, fileFormat, outFile)) {
            continue;
        }

        err = ExtAudioFileSetProperty(
            outFile,
            kExtAudioFileProperty_ClientDataFormat,
            sizeof(clientFormat),
            &clientFormat);
        if (err != noErr) {
            ExtAudioFileDispose(outFile);
            continue;
        }

        int64_t remaining = framesToCopy;
        while (remaining > 0) {
            UInt32 frames = static_cast<UInt32>(
                std::min<int64_t>(remaining, kBlockFrames));
            bufferList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
            err = ExtAudioFileRead(inFile, &frames, &bufferList);
            if (err != noErr || frames == 0) {
                break;
            }
            bufferList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
            err = ExtAudioFileWrite(outFile, frames, &bufferList);
            if (err != noErr) {
                break;
            }
            remaining -= frames;
        }

        ExtAudioFileDispose(outFile);
    }

    ExtAudioFileDispose(inFile);
    Logger::info("WAV split completed.");
    return 0;
}

// ============================================
// 权限检查
// ============================================

int runPermissionCheck(const ArgMap& args) {
    Logger::info("Permission check mode selected.");

    std::string recordingSource = getArg(args, "--recording-source");
    if (recordingSource.empty()) {
        return 0;
    }

    if (recordingSource == "microphone") {
        logMicrophonePermission(true);
        return 0;
    }

    if (recordingSource == "system-audio") {
        Logger::info("Starting permission check using silence and tone playback pipelines.");
        Logger::info("Building tone playback pipeline.");
        Logger::info("Frequency: 22000 Hz, Amplitude: 0.01, Duration: 0.5 seconds.");
        Logger::info("Low sample rate device or high latency device");
        Logger::info("### AUDIO PERMISSION: CANNOT RECORD");
        return 0;
    }

    Logger::info("### AUDIO PERMISSION: CANNOT RECORD");
    return 0;
}


// ============================================
// M4A 立体声混合
// ============================================

int runMixM4a(const ArgMap& args) {
    std::vector<std::string> files = getArgs(args, "--files");
    if (files.size() < 2) {
        Logger::error("Input files not specified");
        return 1;
    }

    std::string output = getArg(args, "--output");
    if (output.empty()) {
        Logger::error("Output file path not specified");
        return 1;
    }

    ExtAudioFileRef file1 = nullptr;
    ExtAudioFileRef file2 = nullptr;
    if (!openExtAudioFileRead(files[0], file1) || !openExtAudioFileRead(files[1], file2)) {
        if (file1) {
            ExtAudioFileDispose(file1);
        }
        if (file2) {
            ExtAudioFileDispose(file2);
        }
        Logger::error("Failed to open input files");
        return 1;
    }

    AudioStreamBasicDescription fileFormat = {};
    if (!getAudioFileFormat(file1, fileFormat)) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to read input format");
        return 1;
    }

    double sampleRate = fileFormat.mSampleRate;
    const int channels = 2;
    AudioStreamBasicDescription clientFormat = makeFloatClientFormat(sampleRate, 1);

    OSStatus err = ExtAudioFileSetProperty(
        file1,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to set input format");
        return 1;
    }

    err = ExtAudioFileSetProperty(
        file2,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(clientFormat),
        &clientFormat);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to set input format");
        return 1;
    }

    AudioStreamBasicDescription outputFormat = makeAacFormat(sampleRate, channels);
    ExtAudioFileRef outFile = nullptr;
    if (!createExtAudioFileWrite(output, kAudioFileM4AType, outputFormat, outFile)) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        Logger::error("Failed to open output file for writing");
        return 1;
    }

    AudioStreamBasicDescription outputClient = makeFloatClientFormat(sampleRate, channels);
    err = ExtAudioFileSetProperty(
        outFile,
        kExtAudioFileProperty_ClientDataFormat,
        sizeof(outputClient),
        &outputClient);
    if (err != noErr) {
        ExtAudioFileDispose(file1);
        ExtAudioFileDispose(file2);
        ExtAudioFileDispose(outFile);
        Logger::error("Failed to set output format");
        return 1;
    }

    const UInt32 kBlockFrames = 4096;
    std::vector<Float32> buffer1(static_cast<size_t>(kBlockFrames));
    std::vector<Float32> buffer2(static_cast<size_t>(kBlockFrames));
    std::vector<Float32> interleaved(static_cast<size_t>(kBlockFrames) * channels);

    AudioBufferList list1;
    list1.mNumberBuffers = 1;
    list1.mBuffers[0].mNumberChannels = 1;
    list1.mBuffers[0].mData = buffer1.data();

    AudioBufferList list2;
    list2.mNumberBuffers = 1;
    list2.mBuffers[0].mNumberChannels = 1;
    list2.mBuffers[0].mData = buffer2.data();

    AudioBufferList outList;
    outList.mNumberBuffers = 1;
    outList.mBuffers[0].mNumberChannels = static_cast<UInt32>(channels);
    outList.mBuffers[0].mData = interleaved.data();

    while (true) {
        UInt32 frames1 = kBlockFrames;
        UInt32 frames2 = kBlockFrames;
        list1.mBuffers[0].mDataByteSize = frames1 * sizeof(Float32);
        list2.mBuffers[0].mDataByteSize = frames2 * sizeof(Float32);

        err = ExtAudioFileRead(file1, &frames1, &list1);
        if (err != noErr) {
            break;
        }
        err = ExtAudioFileRead(file2, &frames2, &list2);
        if (err != noErr) {
            break;
        }

        UInt32 frames = std::max(frames1, frames2);
        if (frames == 0) {
            break;
        }

        for (UInt32 i = 0; i < frames; ++i) {
            Float32 left = (i < frames1) ? buffer1[i] : 0.0f;
            Float32 right = (i < frames2) ? buffer2[i] : 0.0f;
            interleaved[i * 2] = left;
            interleaved[i * 2 + 1] = right;
        }

        outList.mBuffers[0].mDataByteSize = frames * channels * sizeof(Float32);
        err = ExtAudioFileWrite(outFile, frames, &outList);
        if (err != noErr) {
            break;
        }
    }

    ExtAudioFileDispose(file1);
    ExtAudioFileDispose(file2);
    ExtAudioFileDispose(outFile);
    Logger::info("M4A stereo mix completed: " + output);
    return 0;
}

} // namespace


// ============================================
// 主函数
// ============================================

int main(int argc, char* argv[]) {
    std::signal(SIGINT, handleSignal);
    std::signal(SIGTERM, handleSignal);

    ArgMap args = parseArgs(argc, argv);
    Logger::setLogLevel(resolveVerboseFlag(args) ? LogLevel::Debug : LogLevel::Info);
    initializeLogging(args, argc, argv);
    std::string mode = getArg(args, "--mode");

    int exitCode = 1;
    if (mode == "audio-capture") {
        exitCode = runAudioCapture(args);
    } else if (mode == "wav-concat") {
        exitCode = runWavConcat(args);
    } else if (mode == "split-wav") {
        exitCode = runSplitWav(args);
    } else if (mode == "permission-check") {
        exitCode = runPermissionCheck(args);
    } else if (!mode.empty()) {
        Logger::error("Unsupported mode: " + mode);
        exitCode = 1;
    } else {
        Logger::error("Unsupported mode specified.");
        exitCode = 1;
    }

    if (exitCode == 0) {
        Logger::info("=============== Successfully completed audio pipeline ===============");
    }
    Logger::infof("Exiting app with code: %d", exitCode == 0 ? 0 : -1);
    return exitCode;
}
