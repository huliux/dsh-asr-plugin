#include <cassert>
#define main captureCliMain
#include "../vendor/bitbook-audio/cli/audio_fmt_convert_no_ct_main.mm"
#undef main

static void checkTail(const std::filesystem::path& directory, int64_t startFrame,
                      UInt32 tailFrames) {
    std::filesystem::create_directories(directory);
    MicRecordingState state{};
    state.outputDir = directory.string();
    state.sourceLabel = "mic";
    state.sampleRate = 16000;
    state.recordingStartTime = 1800000000;
    state.chunkStartFrame = startFrame;
    state.totalFramesWritten = startFrame + tailFrames;
    state.currentChunkPath = (directory / "temp_chunk_tail.wav").string();
    auto format = makePcmFormat(16000, 1, 16, false);
    assert(createExtAudioFileWrite(state.currentChunkPath, kAudioFileWAVEType,
                                  format, state.currentChunkFile));
    if (tailFrames > 0) {
        std::vector<int16_t> samples(tailFrames, 1000);
        AudioBufferList buffers{};
        buffers.mNumberBuffers = 1;
        buffers.mBuffers[0] = {1, tailFrames * 2, samples.data()};
        assert(ExtAudioFileWrite(state.currentChunkFile, tailFrames, &buffers) == noErr);
    }
    finalizeMicRecordingChunk(state);
    assert(state.currentChunkFile == nullptr);
    size_t files = 0;
    for (const auto& entry : std::filesystem::directory_iterator(directory)) {
        ++files;
        assert(tailFrames > 0);
        ExtAudioFileRef file = nullptr;
        CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr,
            reinterpret_cast<const UInt8*>(entry.path().c_str()), entry.path().string().size(), false);
        assert(ExtAudioFileOpenURL(url, &file) == noErr);
        CFRelease(url);
        SInt64 frames = 0;
        UInt32 size = sizeof(frames);
        assert(ExtAudioFileGetProperty(file, kExtAudioFileProperty_FileLengthFrames,
                                       &size, &frames) == noErr);
        assert(frames == tailFrames);
        ExtAudioFileDispose(file);
    }
    assert(files == (tailFrames > 0 ? 1u : 0u));
    finalizeMicRecordingChunk(state);
    std::filesystem::remove_all(directory);
}

int main() {
    @autoreleasepool {
        const auto root = std::filesystem::path(NSTemporaryDirectory().UTF8String) /
            NSUUID.UUID.UUIDString.UTF8String;
        checkTail(root / "empty-start", 0, 0);
        checkTail(root / "empty-rollover", 80000, 0);
        checkTail(root / "short-tail", 80000, 160);
        std::filesystem::remove_all(root);
        fprintf(stdout, "{\"microphone_tail_tests\":\"passed\"}\n");
    }
}
