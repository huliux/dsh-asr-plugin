#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#include <cassert>
#include <cmath>
#include <filesystem>
#include <vector>
#include <unistd.h>

// The HAL edge supplies deterministic device formats and callbacks. WAV creation,
// conversion, flushing and capture implementation remain the real native code.
static double inputRate = 16000;
static UInt32 inputChannels = 1;
static AudioDeviceIOProc callback = nullptr;
static void* callbackContext = nullptr;

static OSStatus propertySize(AudioObjectID, const AudioObjectPropertyAddress*,
                            UInt32, const void*, UInt32* size) {
    *size = sizeof(AudioObjectID);
    return noErr;
}

static OSStatus propertyData(AudioObjectID, const AudioObjectPropertyAddress* address,
                            UInt32, const void*, UInt32* size, void* data) {
    if (address->mSelector == kAudioDevicePropertyStreams) {
        *static_cast<AudioObjectID*>(data) = 42;
        *size = sizeof(AudioObjectID);
    } else if (address->mSelector == kAudioStreamPropertyDirection) {
        *static_cast<UInt32*>(data) = 1;
    } else if (address->mSelector == kAudioStreamPropertyVirtualFormat) {
        auto& format = *static_cast<AudioStreamBasicDescription*>(data);
        format = {};
        format.mSampleRate = inputRate;
        format.mFormatID = kAudioFormatLinearPCM;
        format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
        format.mChannelsPerFrame = inputChannels;
        format.mFramesPerPacket = 1;
        format.mBytesPerFrame = format.mBytesPerPacket = sizeof(Float32) * inputChannels;
        format.mBitsPerChannel = 32;
        *size = sizeof(format);
    } else return kAudioHardwareUnknownPropertyError;
    return noErr;
}

static OSStatus createIO(AudioObjectID, AudioDeviceIOProc proc, void* context,
                         AudioDeviceIOProcID* result) {
    callback = proc;
    callbackContext = context;
    *result = proc;
    return noErr;
}
static OSStatus deviceIO(AudioObjectID, AudioDeviceIOProcID) { return noErr; }

#define AudioObjectGetPropertyDataSize propertySize
#define AudioObjectGetPropertyData propertyData
#define AudioDeviceCreateIOProcID createIO
#define AudioDeviceDestroyIOProcID deviceIO
#define AudioDeviceStart deviceIO
#define AudioDeviceStop deviceIO
#include "../vendor/bitbook-audio/audio_recorder_v4.mm"
#undef AudioObjectGetPropertyDataSize
#undef AudioObjectGetPropertyData
#undef AudioDeviceCreateIOProcID
#undef AudioDeviceDestroyIOProcID
#undef AudioDeviceStart
#undef AudioDeviceStop

static void sendTone(double rate, int seconds, UInt32 channels = 1) {
    inputRate = rate;
    inputChannels = channels;
    const UInt32 frames = static_cast<UInt32>(rate / 100);
    std::vector<Float32> samples(frames * channels);
    for (UInt32 index = 0; index < frames; ++index) {
        for (UInt32 channel = 0; channel < channels; ++channel) {
            samples[index * channels + channel] = 0.25 * std::sin(2 * M_PI * 1000 * index / rate);
        }
    }
    AudioBufferList buffers = {1, {{channels, static_cast<UInt32>(samples.size() * sizeof(Float32)), samples.data()}}};
    AudioBufferList output = {};
    AudioTimeStamp timestamp = {};
    for (int block = 0; block < seconds * 100; ++block) {
        assert(callback(7, &timestamp, &buffers, &timestamp, &output, &timestamp, callbackContext) == noErr);
        usleep(1000);
    }
}

static bool correctPitch(ExtAudioFileRef file) {
    auto format = bitbook::makeFloatClientFormat(16000, 1);
    assert(ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, sizeof(format), &format) == noErr);
    std::vector<Float32> samples(16000);
    AudioBufferList buffers = {1, {{1, 64000, samples.data()}}};
    UInt32 frames = 16000;
    assert(ExtAudioFileRead(file, &frames, &buffers) == noErr && frames == 16000);
    int crossings = 0;
    for (UInt32 index = 801; index < 15200; ++index) {
        if (samples[index - 1] <= 0 && samples[index] > 0) ++crossings;
    }
    fprintf(stderr, "system format: expected 900 tone cycles, actual %d\n", crossings);
    return std::abs(crossings - 900) <= 2;
}

static double wavDuration(const std::filesystem::path& path, bool& pitchValid) {
    NSURL* url = [NSURL fileURLWithPath:@(path.c_str())];
    ExtAudioFileRef file = nullptr;
    assert(ExtAudioFileOpenURL((__bridge CFURLRef)url, &file) == noErr);
    SInt64 frames = 0;
    UInt32 size = sizeof(frames);
    assert(ExtAudioFileGetProperty(file, kExtAudioFileProperty_FileLengthFrames, &size, &frames) == noErr);
    AudioStreamBasicDescription format = {};
    size = sizeof(format);
    assert(ExtAudioFileGetProperty(file, kExtAudioFileProperty_FileDataFormat, &size, &format) == noErr);
    assert(format.mSampleRate == 16000 && format.mChannelsPerFrame == 1);
    pitchValid = correctPitch(file) && pitchValid;
    assert(ExtAudioFileDispose(file) == noErr);
    return frames / format.mSampleRate;
}

int main() {
    @autoreleasepool {
        char directory[] = "/tmp/dsh-asr-system-format-XXXXXX";
        assert(mkdtemp(directory) != nullptr);
        RecorderConfig config;
        config.outputFormat = OutputFileFormat::Wav;
        config.outputSampleRate = 16000;
        config.outputChannels = 1;
        config.outputBitsPerSample = 16;
        config.chunkSizeSeconds = 5;
        config.sourceLabel = "system";
        {
            bitbook::AudioRecorderV4 recorder(directory, 7, {}, &config);
            assert(recorder.setup() && recorder.start());
            sendTone(16000, 4);
            // Same stream count; no user action and no tap-list change event.
            sendTone(48000, 4, 2);
            recorder.stop();
        }
        double duration = 0;
        bool pitchValid = true;
        for (const auto& entry : std::filesystem::directory_iterator(directory)) {
            assert(entry.path().filename().string().find("temp_") != 0);
            duration += wavDuration(entry.path(), pitchValid);
        }
        std::filesystem::remove_all(directory);
        fprintf(stderr, "system format: expected 8.000 seconds, actual %.3f seconds\n", duration);
        return std::abs(duration - 8.0) < 0.01 && pitchValid ? 0 : 1;
    }
}
