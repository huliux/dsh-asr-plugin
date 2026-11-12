#import "RHDevices.h"

#import <CoreAudio/CoreAudio.h>
#import <stdlib.h>

static NSString *_Nullable RHDeviceString(AudioObjectID deviceID,
                                          AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {
    selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain,
  };
  CFStringRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(deviceID, &address, 0, NULL, &size, &value) != noErr ||
      value == NULL) return nil;
  NSString *text = CFBridgingRelease(value);
  return text.length == 0 ? nil : text;
}

static NSInteger RHDeviceChannelCount(AudioObjectID deviceID,
                                      AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreamConfiguration, scope, kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(deviceID, &address, 0, NULL, &size) != noErr ||
      size < sizeof(AudioBufferList)) return 0;
  AudioBufferList *buffers = malloc(size);
  if (buffers == NULL) return 0;
  NSInteger channels = 0;
  if (AudioObjectGetPropertyData(deviceID, &address, 0, NULL, &size, buffers) == noErr) {
    for (UInt32 index = 0; index < buffers->mNumberBuffers; index += 1) {
      channels += (NSInteger)buffers->mBuffers[index].mNumberChannels;
    }
  }
  free(buffers);
  return channels;
}

static NSString *_Nullable RHDefaultDeviceUID(AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {
    selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain,
  };
  AudioObjectID deviceID = kAudioObjectUnknown;
  UInt32 size = sizeof(deviceID);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size,
                                 &deviceID) != noErr ||
      deviceID == kAudioObjectUnknown) return nil;
  return RHDeviceString(deviceID, kAudioDevicePropertyDeviceUID);
}

@interface RHAudioDevice ()
@property(nonatomic, readwrite, copy) NSString *uid;
@property(nonatomic, readwrite, copy) NSString *name;
@property(nonatomic, readwrite) NSInteger inputChannels;
@property(nonatomic, readwrite) NSInteger outputChannels;
@end

@implementation RHAudioDevice
@end

@interface RHAudioDeviceInventory ()
@property(nonatomic, readwrite, copy, nullable) NSString *defaultInputUID;
@property(nonatomic, readwrite, copy, nullable) NSString *defaultOutputUID;
@property(nonatomic, readwrite, copy) NSArray<RHAudioDevice *> *devices;
@end

@implementation RHAudioDeviceInventory

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  _devices = @[];
  return self;
}

- (NSData *)jsonDataWithError:(NSError **)error {
  NSMutableArray<NSDictionary<NSString *, id> *> *devices = [NSMutableArray array];
  for (RHAudioDevice *device in self.devices) {
    [devices addObject:@{
      @"uid": device.uid,
      @"name": device.name,
      @"input_channels": @(device.inputChannels),
      @"output_channels": @(device.outputChannels),
      @"default_input": @([device.uid isEqualToString:self.defaultInputUID ?: @""]),
      @"default_output": @([device.uid isEqualToString:self.defaultOutputUID ?: @""]),
    }];
  }
  NSDictionary<NSString *, id> *payload = @{
    @"schema_version": @(1),
    @"default_input_uid": self.defaultInputUID ?: NSNull.null,
    @"default_output_uid": self.defaultOutputUID ?: NSNull.null,
    @"devices": devices,
  };
  return [NSJSONSerialization dataWithJSONObject:payload options:0 error:error];
}

@end

RHAudioDeviceInventory *RHReadAudioDeviceInventory(void) {
  RHAudioDeviceInventory *inventory = [[RHAudioDeviceInventory alloc] init];
  inventory.defaultInputUID = RHDefaultDeviceUID(kAudioHardwarePropertyDefaultInputDevice);
  inventory.defaultOutputUID = RHDefaultDeviceUID(kAudioHardwarePropertyDefaultOutputDevice);

  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr ||
      size < sizeof(AudioDeviceID)) return inventory;
  AudioDeviceID *ids = malloc(size);
  if (ids == NULL) return inventory;
  NSInteger count = (NSInteger)(size / sizeof(AudioDeviceID));
  NSMutableArray<RHAudioDevice *> *devices = [NSMutableArray arrayWithCapacity:(NSUInteger)count];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, ids) == noErr) {
    for (NSInteger index = 0; index < count; index += 1) {
      NSString *uid = RHDeviceString(ids[index], kAudioDevicePropertyDeviceUID);
      NSString *name = RHDeviceString(ids[index], kAudioObjectPropertyName);
      NSInteger inputs = RHDeviceChannelCount(ids[index], kAudioObjectPropertyScopeInput);
      NSInteger outputs = RHDeviceChannelCount(ids[index], kAudioObjectPropertyScopeOutput);
      if (uid == nil || (inputs == 0 && outputs == 0)) continue;
      RHAudioDevice *device = [[RHAudioDevice alloc] init];
      device.uid = uid;
      device.name = name ?: uid;
      device.inputChannels = inputs;
      device.outputChannels = outputs;
      [devices addObject:device];
    }
  }
  free(ids);
  inventory.devices = devices;
  return inventory;
}
