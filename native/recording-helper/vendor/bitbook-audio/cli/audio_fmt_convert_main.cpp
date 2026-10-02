#include <atomic>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <regex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>

#include "audio_device_manager.h"
#include "config/config_types.h"
#include "managers/process_tap_manager.h"
#include "managers/recording_engine.h"
#include "utils/logger.h"

using bitbook::AudioDeviceManager;
using bitbook::utils::Logger;
using bitbook::utils::LogLevel;

namespace {

struct ArgMap {
    std::unordered_map<std::string, std::vector<std::string>> values;
};

bool parseBool(const std::string& value);
std::string getArg(const ArgMap& args, const std::string& key);

std::string buildSystemAudioPermissionProbeOutputDir(const ArgMap& args) {
    std::string tempDir = getArg(args, "--temp-dir");
    std::filesystem::path basePath = tempDir.empty()
        ? std::filesystem::temp_directory_path()
        : std::filesystem::path(tempDir);

    std::filesystem::path outputDir = basePath / "permission-probe";
    std::error_code err;
    std::filesystem::create_directories(outputDir, err);
    return outputDir.string();
}

bool checkSystemAudioPermissionWithRecordingProbe(const ArgMap& args) {
    RecordingConfig config;
    config.sources.clear();

    AudioSource tapSource;
    tapSource.type = AudioSourceType::ProcessTap;
    tapSource.pid = 0;
    config.sources.push_back(tapSource);

    config.tap.isExclusive = true;
    config.tap.muteBehavior = TapConfig::MuteBehavior::Unmuted;
    config.tap.mixdownMode = TapConfig::MixdownMode::Stereo;

    const std::string outputDir = buildSystemAudioPermissionProbeOutputDir(args);
    config.recorder.outputBasePath = outputDir;
    config.recorder.outputFormat = OutputFileFormat::Wav;
    config.recorder.outputSampleRate = 16000.0;
    config.recorder.outputBitsPerSample = 16;
    config.recorder.outputChannels = 1;
    config.recorder.outputFloat = false;
    config.recorder.chunkSizeSeconds = 1.0;

    config.runtime.autoStopOnProcessExit = false;
    config.runtime.enableProcessBlacklist = false;

    RecordingEngine engine(config);
    if (!engine.setup()) {
        Logger::warning("System-audio recording permission probe setup failed: " + engine.getLastError());
        return false;
    }

    if (!engine.start()) {
        Logger::warning("System-audio recording permission probe start failed: " + engine.getLastError());
        return false;
    }

    engine.stop();

    std::error_code cleanupErr;
    std::filesystem::remove_all(outputDir, cleanupErr);
    Logger::info("System-audio recording permission probe succeeded.");
    return true;
}

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
        R"(^(.+-FINAL-)?(\d+\.\d+)-(\d+\.\d+)-(system|mic|combined|temp)\.wav$)");
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
        if (!requireInput && !device.isOutput) {
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

std::string resolveDefaultDeviceUID(bool requireInput) {
    AudioObjectID deviceID = requireInput
        ? AudioDeviceManager::getDefaultInputDevice()
        : AudioDeviceManager::getDefaultOutputDevice();

    if (deviceID == kAudioObjectUnknown) {
        return "";
    }

    return AudioDeviceManager::getDeviceUID(deviceID);
}

std::atomic<bool> g_shouldStop{false};

void handleSignal(int) {
    g_shouldStop.store(true);
}

int runAudioCapture(const ArgMap& args) {
    Logger::info("Audio recording mode selected.");

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
    if (!parseDouble(getArg(args, "--chunk-size"), chunkSizeSeconds)) {
        Logger::error("Chunk size not specified");
        return 1;
    }
    if (chunkSizeSeconds <= 0.0) {
        Logger::error("Chunk size must be greater than 0 seconds.");
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

    RecordingConfig config;
    config.sources.clear();

    if (recordingSource == "microphone") {
        Logger::info("Starting microphone recording pipeline setup.");
        AudioSource source;
        source.type = AudioSourceType::Microphone;
        source.deviceUID = resolveDeviceUID(deviceId, true);
        config.sources.push_back(source);
        config.recorder.sourceLabel = "mic";
    } else {
        Logger::info("Starting system audio recording pipeline setup.");

        // 只添加 ProcessTap 源，不需要麦克风
        // 参考 audiotee 项目和原始 audioFmtConvert：
        // Process Tap 可以直接添加到 Aggregate Device，Tap 本身提供时钟
        AudioSource tapSource;
        tapSource.type = AudioSourceType::ProcessTap;
        tapSource.pid = 0;  // 全局模式，捕获所有系统音频
        config.sources.push_back(tapSource);

        // ✅ 关键配置：设置 isExclusive = true
        // 参考 audiotee 项目：空进程列表 + isExclusive=true = 捕获所有进程音频
        // isExclusive 的含义是反转的：true 表示"不排除任何进程"
        config.tap.isExclusive = true;

        const std::string outputDeviceUID =
            !deviceId.empty() && deviceId != "default"
                ? resolveDeviceUID(deviceId, false)
                : resolveDefaultDeviceUID(false);

        if (!outputDeviceUID.empty()) {
            config.tap.mixdownMode = TapConfig::MixdownMode::DeviceFormat;
            config.tap.deviceUID = outputDeviceUID;
            config.tap.streamIndex = 0;
            Logger::info("System audio tap bound to output device UID: " + outputDeviceUID);
        } else {
            Logger::warning(
                "System audio tap could not resolve an output device UID, falling back to CoreAudio default routing"
            );
        }

        config.recorder.sourceLabel = "system";
    }

    config.recorder.outputBasePath = outputDir;
    config.recorder.outputFormat = OutputFileFormat::Wav;
    config.recorder.outputSampleRate = sampleRate;
    config.recorder.outputBitsPerSample = bitsPerSample;
    config.recorder.outputChannels = channels;
    config.recorder.outputFloat = false;
    config.recorder.chunkSizeSeconds = chunkSizeSeconds;

    config.runtime.autoStopOnProcessExit = false;
    config.runtime.enableProcessBlacklist = false;

    RecordingEngine engine(config);
    if (!engine.setup()) {
        Logger::error(engine.getLastError());
        return 1;
    }

    // PCM stdout 流输出（用于云端实时转写）
    bool pcmStdout = parseBool(getArg(args, "--pcm-stdout"));
    if (pcmStdout) {
        engine.enablePcmStdout(sampleRate, channels);
        Logger::info("PCM stdout stream enabled for cloud realtime transcription.");
    }

    if (!engine.start()) {
        Logger::error(engine.getLastError());
        return 1;
    }

    Logger::infof("Audio recording process started with chunk size: %.6f, and recording source: %s",
                  chunkSizeSeconds,
                  recordingSource.c_str());

    auto startTime = std::chrono::steady_clock::now();
    while (!g_shouldStop.load() && engine.isRecording()) {
        if (durationSeconds > 0.0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::duration<double>>(
                std::chrono::steady_clock::now() - startTime);
            if (elapsed.count() >= durationSeconds) {
                break;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    engine.stop();
    return 0;
}

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
    return 0;
}

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
    return 0;
}

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
    return 0;
}

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
    return 0;
}

int runPermissionCheck(const ArgMap& args) {
    Logger::info("Permission check mode selected.");

    std::string recordingSource = getArg(args, "--recording-source");
    if (recordingSource.empty()) {
        return 0;
    }

    if (recordingSource == "microphone") {
        Logger::info("### AUDIO PERMISSION: OK TO RECORD");
        return 0;
    }

    if (recordingSource == "system-audio") {
        const bool canRecord = checkSystemAudioPermissionWithRecordingProbe(args);
        Logger::info(canRecord ? "### AUDIO PERMISSION: OK TO RECORD"
                               : "### AUDIO PERMISSION: CANNOT RECORD");
        return 0;
    }

    Logger::info("### AUDIO PERMISSION: CANNOT RECORD");
    return 0;
}

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
    return 0;
}

} // namespace

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
    } else if (mode == "convert" || mode == "mix-m4a") {
        Logger::error("Unsupported mode specified.");
        exitCode = 1;
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
