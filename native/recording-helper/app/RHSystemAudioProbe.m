#import "RHSystemAudioProbe.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <math.h>
#import <unistd.h>
#import <stdatomic.h>

typedef struct {
  double firstFrequency;
  double secondFrequency;
  double sampleRate;
  double first;
  double previousFirst;
  double second;
  double previousSecond;
  UInt64 frames;
  atomic_bool matched;
} RHProbeSamples;

static void RHAccumulateTone(AudioBuffer buffer, RHProbeSamples *probe) {
  if (buffer.mData == NULL || buffer.mNumberChannels == 0) return;
  UInt32 n = buffer.mDataByteSize / sizeof(float) / buffer.mNumberChannels;
  const float *values = buffer.mData;
  double c1 = 2 * cos(2 * M_PI * probe->firstFrequency / probe->sampleRate);
  double c2 = 2 * cos(2 * M_PI * probe->secondFrequency / probe->sampleRate);
  for (UInt32 i = 0; i < n; i++) {
    double value = values[i * buffer.mNumberChannels];
    if (!isfinite(value)) value = 0;
    double nextFirst = value + c1 * probe->first - probe->previousFirst;
    double nextSecond = value + c2 * probe->second - probe->previousSecond;
    probe->previousFirst = probe->first; probe->first = nextFirst;
    probe->previousSecond = probe->second; probe->second = nextSecond;
  }
  probe->frames += n;
}

static BOOL RHMatchedTone(RHProbeSamples *probe) {
  if (probe->frames < probe->sampleRate * 0.1) return NO;
  double c1 = 2 * cos(2 * M_PI * probe->firstFrequency / probe->sampleRate);
  double c2 = 2 * cos(2 * M_PI * probe->secondFrequency / probe->sampleRate);
  double p1 = probe->first * probe->first + probe->previousFirst * probe->previousFirst -
    c1 * probe->first * probe->previousFirst;
  double p2 = probe->second * probe->second + probe->previousSecond * probe->previousSecond -
    c2 * probe->second * probe->previousSecond;
  double countSquared = (double)probe->frames * probe->frames;
  // Coherent tone energy stays measurable when unrelated playback is mixed in.
  return p1 / countSquared > 0.000025 && p2 / countSquared > 0.000025;
}

static OSStatus RHProbeIO(AudioObjectID device, const AudioTimeStamp *now,
                          const AudioBufferList *input, const AudioTimeStamp *inputTime,
                          AudioBufferList *output, const AudioTimeStamp *outputTime, void *context) {
  RHProbeSamples *samples = context;
  if (input->mNumberBuffers > 0) RHAccumulateTone(input->mBuffers[0], samples);
  if (RHMatchedTone(samples)) atomic_store_explicit(&samples->matched, true, memory_order_release);
  return noErr;
}

static AVAudioPlayer *RHProbePlayer(RHProbeSamples *probe) {
  const UInt32 frames = 6000;
  const UInt32 header[] = {0x46464952, 36 + frames * 2, 0x45564157, 0x20746d66,
    16, 0x00010001, 48000, 96000, 0x00100002, 0x61746164, frames * 2};
  NSMutableData *wave = [NSMutableData dataWithBytes:header length:sizeof(header)];
  for (UInt32 i = 0; i < frames; i++) {
    double envelope = fmin(1.0, fmin(i / 240.0, (frames - i) / 240.0));
    double frequency = i < frames / 2 ? probe->firstFrequency : probe->secondFrequency;
    int16_t value = (int16_t)(32767 * 0.08 * envelope * sin(2 * M_PI * frequency * i / 48000));
    [wave appendBytes:&value length:sizeof(value)];
  }
  AVAudioPlayer *player = [[AVAudioPlayer alloc] initWithData:wave error:nil];
  [player prepareToPlay];
  return player;
}

static BOOL RHProbeFormatSupported(AudioObjectID tap, RHProbeSamples *probe) {
  AudioStreamBasicDescription format = {};
  UInt32 size = sizeof(format);
  AudioObjectPropertyAddress address = { kAudioTapPropertyFormat,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(tap, &address, 0, NULL, &size, &format) != noErr) return NO;
  probe->sampleRate = format.mSampleRate;
  return format.mSampleRate > 0 &&
    format.mFormatID == kAudioFormatLinearPCM && format.mBitsPerChannel == 32 &&
    (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
}

static AudioObjectID RHCreateMutedPlayerTap(void) API_AVAILABLE(macos(14.2));
static AudioObjectID RHCreateMutedPlayerTap(void) {
  pid_t processID = getpid();
  AudioObjectID process = kAudioObjectUnknown;
  UInt32 size = sizeof(process);
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  for (int i = 0; i < 15; i++) {
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(processID),
        &processID, &size, &process) == noErr && process != kAudioObjectUnknown) break;
    [NSThread sleepForTimeInterval:0.01];
  }
  if (process == kAudioObjectUnknown) return kAudioObjectUnknown;
  CATapDescription *description = [[CATapDescription alloc] initStereoMixdownOfProcesses:@[@(process)]];
  description.privateTap = YES;
  // Suppress only this probe process; never mute the global capture tap.
  description.muteBehavior = CATapMuted;
  AudioObjectID tap = kAudioObjectUnknown;
  if (AudioHardwareCreateProcessTap(description, &tap) != noErr) return kAudioObjectUnknown;
  return tap;
}

typedef struct {
  AudioObjectID device;
  AudioDeviceIOProcID callback;
  BOOL started;
} RHProbeReader;

static void RHCloseProbeReader(RHProbeReader *reader) {
  if (reader->started) AudioDeviceStop(reader->device, reader->callback);
  if (reader->callback != NULL) AudioDeviceDestroyIOProcID(reader->device, reader->callback);
  if (reader->device != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(reader->device);
}

static BOOL RHStartProbeReader(AudioObjectID tap, AudioDeviceIOProc proc, void *context,
                               RHProbeReader *reader) {
  CFStringRef uid = NULL;
  UInt32 size = sizeof(uid);
  AudioObjectPropertyAddress address = { kAudioTapPropertyUID,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(tap, &address, 0, NULL, &size, &uid) != noErr || uid == NULL) return NO;
  NSDictionary *spec = @{
    @kAudioAggregateDeviceNameKey: @"DSH recording permission check",
    @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceIsPrivateKey: @YES,
    @kAudioAggregateDeviceTapAutoStartKey: @YES,
    @kAudioAggregateDeviceSubDeviceListKey: @[],
    @kAudioAggregateDeviceTapListKey: @[@{ @kAudioSubTapUIDKey: (__bridge NSString *)uid,
      @kAudioSubTapDriftCompensationKey: @YES }],
  };
  CFRelease(uid);
  if (AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)spec, &reader->device) != noErr) return NO;
  if (AudioDeviceCreateIOProcID(reader->device, proc, context, &reader->callback) != noErr) return NO;
  reader->started = AudioDeviceStart(reader->device, reader->callback) == noErr;
  return reader->started;
}

static OSStatus RHMutedProbeIO(AudioObjectID device, const AudioTimeStamp *now,
                               const AudioBufferList *input, const AudioTimeStamp *inputTime,
                               AudioBufferList *output, const AudioTimeStamp *outputTime, void *context) {
  atomic_store_explicit((atomic_bool *)context, true, memory_order_release);
  return noErr;
}

static BOOL RHWaitForMuteReader(atomic_bool *ready) {
  for (int i = 0; i < 200; i++) {
    if (atomic_load_explicit(ready, memory_order_acquire)) return YES;
    [NSThread sleepForTimeInterval:0.01];
  }
  return NO;
}

static BOOL RHWaitForSignal(RHProbeSamples *samples) {
  for (int i = 0; i < 120; i++) {
    if (atomic_load_explicit(&samples->matched, memory_order_acquire)) return YES;
    [NSThread sleepForTimeInterval:0.01];
  }
  return NO;
}

static BOOL RHRunProbe(AVAudioPlayer *player, RHProbeSamples *samples) API_AVAILABLE(macos(14.2));
static BOOL RHRunProbe(AVAudioPlayer *player, RHProbeSamples *samples) {
  CATapDescription *description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
  description.privateTap = YES;
  description.muteBehavior = CATapUnmuted;
  AudioObjectID tap = kAudioObjectUnknown;
  if (AudioHardwareCreateProcessTap(description, &tap) != noErr) return NO;
  RHProbeReader reader = {0};
  BOOL started = RHProbeFormatSupported(tap, samples) && RHStartProbeReader(tap, RHProbeIO, samples, &reader);
  BOOL verified = NO;
  if (started) {
    player.currentTime = 0;
    player.volume = 1;
    [player play];
    verified = RHWaitForSignal(samples);
    [player stop];
  }
  RHCloseProbeReader(&reader);
  AudioHardwareDestroyProcessTap(tap);
  return verified;
}

BOOL RHVerifySystemAudio(void) {
  if (@available(macOS 14.2, *)) {
    RHProbeSamples samples = {0};
    atomic_init(&samples.matched, false);
    samples.firstFrequency = 700 + arc4random_uniform(300);
    samples.secondFrequency = 1400 + arc4random_uniform(500);
    AVAudioPlayer *player = RHProbePlayer(&samples);
    player.volume = 0;
    player.numberOfLoops = -1;
    if (player == nil || ![player play]) return NO;
    AudioObjectID mutedTap = RHCreateMutedPlayerTap();
    RHProbeReader muteReader = {0};
    atomic_bool ready = false;
    BOOL muted = mutedTap != kAudioObjectUnknown &&
      RHStartProbeReader(mutedTap, RHMutedProbeIO, &ready, &muteReader) && RHWaitForMuteReader(&ready);
    BOOL verified = muted && RHRunProbe(player, &samples);
    [player stop];
    RHCloseProbeReader(&muteReader);
    if (mutedTap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(mutedTap);
    return verified;
  }
  return NO;
}
