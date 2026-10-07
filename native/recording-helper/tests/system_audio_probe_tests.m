#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <assert.h>
#import <unistd.h>

static NSMutableDictionary<NSNumber *, CATapDescription *> *taps;
static NSMutableDictionary<NSNumber *, NSDictionary *> *devices;
static NSMutableSet<NSNumber *> *running;
static AudioObjectID nextObject;
static BOOL failMuteStart;
static BOOL failGlobalStart;
static BOOL skipMuteCallback;
static float playerVolume;
static int signals;
static BOOL simulateSignal;
static void feedSignal(void);
static NSMutableDictionary<NSNumber *, NSValue *> *contexts;

static BOOL activeMute(void) {
  for (NSNumber *device in running) {
    NSArray *entries = devices[device][@kAudioAggregateDeviceTapListKey];
    for (NSDictionary *entry in entries) {
      for (CATapDescription *tap in taps.allValues) {
        if ([entry[@kAudioSubTapUIDKey] isEqual:tap.UUID.UUIDString] &&
            tap.muteBehavior == CATapMuted && !tap.exclusive &&
            [tap.processes isEqualToArray:@[@42]]) return YES;
      }
    }
  }
  return NO;
}

@interface RHTestPlayer : NSObject
@property (nonatomic) float volume;
@property NSTimeInterval currentTime;
@property NSInteger numberOfLoops;
- (instancetype)initWithData:(NSData *)data error:(NSError **)error;
- (BOOL)prepareToPlay;
- (BOOL)play;
- (void)stop;
@end
@implementation RHTestPlayer
- (instancetype)initWithData:(NSData *)data error:(NSError **)error { return [super init]; }
- (BOOL)prepareToPlay { return YES; }
- (void)setVolume:(float)value {
  if (value > 0) {
    assert(activeMute() && "probe signal reached output before the mute reader started");
    signals++;
  }
  _volume = value; playerVolume = value;
}
- (BOOL)play { if (_volume > 0 && simulateSignal) feedSignal(); return YES; }
- (void)stop { _volume = 0; playerVolume = 0; }
@end

static OSStatus propertyData(AudioObjectID object, const AudioObjectPropertyAddress *address,
                             UInt32 qualifierSize, const void *qualifier, UInt32 *size, void *data) {
  if (address->mSelector == kAudioHardwarePropertyTranslatePIDToProcessObject) {
    assert(qualifierSize == sizeof(pid_t) && *(pid_t *)qualifier == getpid());
    *(AudioObjectID *)data = 42; *size = sizeof(AudioObjectID);
  } else if (address->mSelector == kAudioTapPropertyUID) {
    *(CFStringRef *)data = CFBridgingRetain(taps[@(object)].UUID.UUIDString);
    *size = sizeof(CFStringRef);
  } else {
    assert(address->mSelector == kAudioTapPropertyFormat);
    AudioStreamBasicDescription format = { .mSampleRate = 48000,
      .mFormatID = kAudioFormatLinearPCM, .mFormatFlags = kAudioFormatFlagIsFloat,
      .mBitsPerChannel = 32, .mChannelsPerFrame = 2 };
    *(AudioStreamBasicDescription *)data = format; *size = sizeof(format);
  }
  return noErr;
}
static OSStatus createTap(CATapDescription *description, AudioObjectID *tap) {
  *tap = ++nextObject; taps[@(*tap)] = description; return noErr;
}
static OSStatus destroyTap(AudioObjectID tap) { [taps removeObjectForKey:@(tap)]; return noErr; }
static OSStatus createDevice(CFDictionaryRef spec, AudioObjectID *device) {
  *device = ++nextObject; devices[@(*device)] = (__bridge NSDictionary *)spec; return noErr;
}
static OSStatus destroyDevice(AudioObjectID device) {
  assert(![running containsObject:@(device)]);
  [devices removeObjectForKey:@(device)]; return noErr;
}
static OSStatus createIO(AudioObjectID device, AudioDeviceIOProc proc, void *context,
                         AudioDeviceIOProcID *result) {
  *result = proc; contexts[@(device)] = [NSValue valueWithPointer:context]; return noErr;
}
static OSStatus startIO(AudioObjectID device, AudioDeviceIOProcID proc) {
  [running addObject:@(device)];
  if (failMuteStart && activeMute()) {
    [running removeObject:@(device)]; return kAudioDevicePermissionsError;
  }
  if (failGlobalStart && running.count == 2) {
    [running removeObject:@(device)]; return kAudioDevicePermissionsError;
  }
  if (skipMuteCallback && activeMute()) return noErr;
  AudioBufferList input = { .mNumberBuffers = 0 };
  AudioTimeStamp time = {0};
  AudioBufferList output = { .mNumberBuffers = 0 };
  proc(device, &time, &input, &time, &output, &time, contexts[@(device)].pointerValue);
  return noErr;
}
static OSStatus stopIO(AudioObjectID device, AudioDeviceIOProcID proc) {
  assert(playerVolume == 0);
  [running removeObject:@(device)]; return noErr;
}
static OSStatus destroyIO(AudioObjectID device, AudioDeviceIOProcID proc) { return noErr; }

#define AVAudioPlayer RHTestPlayer
#define AudioObjectGetPropertyData propertyData
#define AudioHardwareCreateProcessTap createTap
#define AudioHardwareDestroyProcessTap destroyTap
#define AudioHardwareCreateAggregateDevice createDevice
#define AudioHardwareDestroyAggregateDevice destroyDevice
#define AudioDeviceCreateIOProcID createIO
#define AudioDeviceStart startIO
#define AudioDeviceStop stopIO
#define AudioDeviceDestroyIOProcID destroyIO
#include "../app/RHSystemAudioProbe.m"

static void reset(void) {
  taps = [NSMutableDictionary new]; devices = [NSMutableDictionary new];
  simulateSignal = NO;
  failMuteStart = NO; failGlobalStart = NO; skipMuteCallback = NO; playerVolume = 0;
  running = [NSMutableSet new]; contexts = [NSMutableDictionary new]; nextObject = 50; signals = 0;
}
static void feedSignal(void) {
  RHProbeSamples *samples = contexts[@(nextObject)].pointerValue;
  float values[4800];
  for (int i = 0; i < 4800; i++) {
    double frequency = i < 2400 ? samples->firstFrequency : samples->secondFrequency;
    values[i] = 0.08 * sin(2 * M_PI * frequency * i / 48000);
  }
  AudioBufferList input = { .mNumberBuffers = 1,
    .mBuffers = {{ .mNumberChannels = 1, .mDataByteSize = sizeof(values), .mData = values }} };
  AudioBufferList output = {0}; AudioTimeStamp time = {0};
  RHProbeIO(nextObject, &time, &input, &time, &output, &time, samples);
}
static void verifyShortSignal(void) {
  RHProbeSamples samples = { .sampleRate = 48000, .firstFrequency = 900, .secondFrequency = 1700 };
  float values[4800];
  for (int i = 0; i < 4800; i++) {
    double frequency = i < 2400 ? 900 : 1700;
    values[i] = 0.08 * sin(2 * M_PI * frequency * i / 48000);
  }
  AudioBuffer buffer = { .mNumberChannels = 1, .mDataByteSize = sizeof(values), .mData = values };
  RHAccumulateTone(buffer, &samples);
  assert(RHMatchedTone(&samples) && "100 ms signal must not incur a fixed one-second wait");
  samples = (RHProbeSamples){ .sampleRate = 48000, .firstFrequency = 900, .secondFrequency = 1700 };
  for (int i = 0; i < 4800; i++) values[i] = 0.08 * sin(2 * M_PI * 900 * i / 48000);
  RHAccumulateTone(buffer, &samples);
  assert(!RHMatchedTone(&samples));
  samples = (RHProbeSamples){ .sampleRate = 48000, .firstFrequency = 900, .secondFrequency = 1700 };
  memset(values, 0, sizeof(values)); RHAccumulateTone(buffer, &samples);
  assert(!RHMatchedTone(&samples));
}
int main(void) {
  @autoreleasepool {
    verifyShortSignal();
    reset(); simulateSignal = YES;
    double start = NSProcessInfo.processInfo.systemUptime;
    assert(RHVerifySystemAudio());
    assert(NSProcessInfo.processInfo.systemUptime - start < 0.5);
    assert(signals == 1 && taps.count == 0 && devices.count == 0 && running.count == 0);
    reset();
    assert(!RHVerifySystemAudio()); // No samples: permission must remain unverified.
    assert(signals == 1 && taps.count == 0 && devices.count == 0 && running.count == 0);
    reset(); failMuteStart = YES;
    assert(!RHVerifySystemAudio());
    assert(signals == 0 && taps.count == 0 && devices.count == 0 && running.count == 0);
    reset(); failGlobalStart = YES;
    assert(!RHVerifySystemAudio() && signals == 0 && running.count == 0);
    reset(); skipMuteCallback = YES;
    assert(!RHVerifySystemAudio() && signals == 0 && running.count == 0);
    puts("system audio probe: signal requires a running self-mute reader; failures stay silent");
  }
  return 0;
}
