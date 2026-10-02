#import "RHCaptureTrack.h"

#import "RHChunkStore.h"
#import "RHJournal.h"
#import "RHProcessRegistry.h"

#import <signal.h>
#import <unistd.h>

static const NSUInteger RHOutputTailLimit = 64 * 1024;
static const NSTimeInterval RHTrackStartTimeout = 120.0;

@interface RHOutputMonitor : NSObject
@property(nonatomic, readonly) NSPipe *pipe;
@property(nonatomic, readonly) BOOL permissionDenied;
@property(nonatomic, readonly) BOOL started;
- (void)invalidate;
@end

@interface RHOutputMonitor ()
@property(nonatomic) BOOL permissionDenied;
@property(nonatomic) BOOL started;
@property(nonatomic, readonly) NSMutableData *tail;
@end

@implementation RHOutputMonitor

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  _pipe = [NSPipe pipe];
  _tail = [NSMutableData data];
  __weak RHOutputMonitor *weakSelf = self;
  _pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    RHOutputMonitor *strongSelf = weakSelf;
    if (strongSelf == nil || data.length == 0) return;
    [strongSelf consume:data];
  };
  return self;
}

- (void)consume:(NSData *)data {
  @synchronized (self) {
    [self.tail appendData:data];
    if (self.tail.length > RHOutputTailLimit) {
      [self.tail replaceBytesInRange:NSMakeRange(0, self.tail.length - RHOutputTailLimit)
                           withBytes:NULL length:0];
    }
    NSString *text = [[NSString alloc] initWithData:self.tail encoding:NSUTF8StringEncoding];
    if (text == nil) return;
    if ([text containsString:@"### AUDIO PERMISSION: CANNOT RECORD"]) {
      self.permissionDenied = YES;
    }
    if ([text containsString:@"Audio recording process started"]) self.started = YES;
  }
}

- (BOOL)permissionDenied {
  @synchronized (self) { return _permissionDenied; }
}

- (BOOL)started {
  @synchronized (self) { return _started; }
}

- (void)invalidate {
  self.pipe.fileHandleForReading.readabilityHandler = nil;
  [self.pipe.fileHandleForReading closeFile];
}

@end

@interface RHCaptureTrack ()
@property(nonatomic, readwrite, nullable) NSString *errorCode;
@property(nonatomic, readwrite, getter=isRequested) BOOL requested;
@property(nonatomic, readwrite) NSString *state;
@property(nonatomic, readonly) NSString *binaryPath;
@property(nonatomic, readonly) NSString *recordingRoot;
@property(nonatomic, readonly) RHChunkStore *chunkStore;
@property(nonatomic, readonly) RHProcessRegistry *registry;
@property(nonatomic, copy, nullable) RHChunkHandler chunkHandler;
@property(nonatomic, copy, nullable) RHTrackStateHandler stateHandler;
@property(nonatomic, strong, nullable) NSTask *task;
@property(nonatomic, strong, nullable) RHOutputMonitor *stdoutMonitor;
@property(nonatomic, strong, nullable) RHOutputMonitor *stderrMonitor;
@property(nonatomic, strong, nullable) NSDate *startedAt;
@property(nonatomic) BOOL receivedSignal;
@property(nonatomic) unsigned long long observedFrames;
@end

@implementation RHCaptureTrack

- (instancetype)initWithName:(NSString *)name
                recordingRoot:(NSString *)recordingRoot
                   binaryRoot:(NSString *)binaryRoot
                     registry:(RHProcessRegistry *)registry
                 chunkHandler:(RHChunkHandler)chunkHandler
                 stateHandler:(RHTrackStateHandler)stateHandler
                        error:(NSError **)error {
  if (![name isEqualToString:@"mic"] && ![name isEqualToString:@"system"]) return nil;
  self = [super init];
  if (self == nil) return nil;
  _name = [name copy];
  _recordingRoot = [recordingRoot copy];
  _registry = registry;
  _chunkHandler = [chunkHandler copy];
  _stateHandler = [stateHandler copy];
  _state = @"off";
  NSString *binaryName = [name isEqualToString:@"mic"]
      ? @"dsh-asr-capture-mic" : @"dsh-asr-capture-system";
  _binaryPath = [binaryRoot stringByAppendingPathComponent:binaryName];
  if (![NSFileManager.defaultManager isExecutableFileAtPath:_binaryPath]) return nil;
  _chunkStore = [[RHChunkStore alloc] initWithRecordingRoot:recordingRoot
                                                      track:name error:error];
  if (_chunkStore == nil) return nil;
  for (NSString *path in @[
    [recordingRoot stringByAppendingPathComponent:@"native-temp"],
  ]) {
    if (!RHEnsureOwnerDirectory(path, error)) return nil;
  }
  return self;
}

- (pid_t)processID {
  return self.task == nil ? 0 : self.task.processIdentifier;
}

- (NSDictionary<NSString *, id> *)snapshot {
  return @{
    @"track": self.name,
    @"state": self.state,
    @"requested": @(self.requested),
    @"error_code": self.errorCode ?: NSNull.null,
  };
}

- (void)transition:(NSString *)state errorCode:(NSString *)errorCode {
  BOOL changed = ![self.state isEqualToString:state] ||
      !((self.errorCode == nil && errorCode == nil) || [self.errorCode isEqualToString:errorCode]);
  self.state = state;
  self.errorCode = errorCode;
  if (changed && self.stateHandler != nil) self.stateHandler(self.snapshot);
}

- (NSArray<NSString *> *)captureArguments {
  NSString *source = [self.name isEqualToString:@"mic"] ? @"microphone" : @"system-audio";
  return @[
    @"--chunk-size", @"5",
    @"--mode", @"audio-capture",
    @"--recording-source", source,
    @"--output-dir", self.chunkStore.incomingRoot,
    @"--default-log-file", @"/dev/null",
    @"--env", @"prod",
    @"--temp-dir", [self.recordingRoot stringByAppendingPathComponent:@"native-temp"],
  ];
}

- (BOOL)systemAudioAvailable {
  if (![self.name isEqualToString:@"system"]) return YES;
  NSOperatingSystemVersion minimum = {.majorVersion = 14, .minorVersion = 2, .patchVersion = 0};
  return [NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:minimum];
}

- (BOOL)requestOn:(NSError **)error {
  self.requested = YES;
  if ([self.state isEqualToString:@"on"] || [self.state isEqualToString:@"starting"]) return YES;
  if (![self systemAudioAvailable]) {
    [self transition:@"failed" errorCode:@"SYSTEM_AUDIO_NOT_AVAILABLE"];
    return YES;
  }
  [self transition:@"starting" errorCode:nil];
  self.receivedSignal = NO;
  self.observedFrames = 0;
  NSTask *task = [[NSTask alloc] init];
  self.stdoutMonitor = [[RHOutputMonitor alloc] init];
  self.stderrMonitor = [[RHOutputMonitor alloc] init];
  task.executableURL = [NSURL fileURLWithPath:self.binaryPath];
  task.arguments = self.captureArguments;
  task.currentDirectoryURL = [NSURL fileURLWithPath:self.recordingRoot isDirectory:YES];
  task.standardOutput = self.stdoutMonitor.pipe;
  task.standardError = self.stderrMonitor.pipe;
  if (![task launchAndReturnError:error]) {
    [self transition:@"failed" errorCode:@"CAPTURE_LAUNCH_FAILED"];
    return NO;
  }
  self.task = task;
  self.startedAt = [NSDate date];
  if (![self.registry setPID:task.processIdentifier binaryPath:self.binaryPath
                    forTrack:self.name error:error]) {
    [self stopChild];
    [self transition:@"failed" errorCode:@"CAPTURE_REGISTRY_FAILED"];
    return NO;
  }
  return YES;
}

- (void)markRequestedFailure:(NSString *)errorCode {
  self.requested = YES;
  [self stopChild];
  [self transition:@"failed" errorCode:errorCode];
}

- (BOOL)promoteChunks:(NSError **)error {
  NSArray<RHChunkMetadata *> *chunks = [self.chunkStore promoteClosedChunksWithError:error];
  if (chunks == nil) return NO;
  for (RHChunkMetadata *chunk in chunks) {
    self.receivedSignal = self.receivedSignal || chunk.hasSignal;
    self.observedFrames += chunk.frameCount;
  }
  if (self.chunkHandler != nil) {
    for (RHChunkMetadata *chunk in chunks) self.chunkHandler(chunk, self.name);
  }
  return YES;
}

- (void)stopChild {
  NSTask *task = self.task;
  if (task == nil) return;
  if (task.isRunning) [task terminate];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
  while (task.isRunning && deadline.timeIntervalSinceNow > 0) usleep(50000);
  if (task.isRunning) kill(task.processIdentifier, SIGKILL);
  [task waitUntilExit];
  [self.stdoutMonitor invalidate];
  [self.stderrMonitor invalidate];
  [self.registry clearTrack:self.name error:nil];
  self.task = nil;
  self.stdoutMonitor = nil;
  self.stderrMonitor = nil;
  self.startedAt = nil;
}

- (BOOL)requestOff:(NSError **)error {
  if (!self.requested && [self.state isEqualToString:@"off"]) return YES;
  self.requested = NO;
  [self stopChild];
  if (![self promoteChunks:error]) {
    [self transition:@"failed" errorCode:@"AUDIO_CHUNK_INVALID"];
    return NO;
  }
  [self transition:@"off" errorCode:nil];
  return YES;
}

- (BOOL)refresh:(NSError **)error {
  if (self.task == nil && [self.state isEqualToString:@"failed"]) return YES;
  if (![self promoteChunks:error]) {
    [self stopChild];
    [self transition:@"failed" errorCode:@"AUDIO_CHUNK_INVALID"];
    return YES;
  }
  if (self.task == nil) return YES;
  if (self.stdoutMonitor.permissionDenied) {
    [self stopChild];
    NSString *code = [self.name isEqualToString:@"mic"]
        ? @"MICROPHONE_PERMISSION_DENIED" : @"SYSTEM_AUDIO_PERMISSION_DENIED";
    [self transition:@"failed" errorCode:code];
    return YES;
  }
  if (self.task.isRunning) {
    if (self.stdoutMonitor.started) {
      BOOL noSignal = [self.name isEqualToString:@"system"] &&
          !self.receivedSignal && self.observedFrames >= 80000;
      [self transition:@"on" errorCode:noSignal ? @"SYSTEM_AUDIO_NO_SIGNAL" : nil];
    }
    if ([self.state isEqualToString:@"starting"] &&
        -self.startedAt.timeIntervalSinceNow > RHTrackStartTimeout) {
      [self stopChild];
      [self transition:@"failed" errorCode:@"CAPTURE_START_TIMEOUT"];
    }
    return YES;
  }
  [self.task waitUntilExit];
  [self.registry clearTrack:self.name error:nil];
  [self.stdoutMonitor invalidate];
  [self.stderrMonitor invalidate];
  self.task = nil;
  self.stdoutMonitor = nil;
  self.stderrMonitor = nil;
  self.startedAt = nil;
  if (![self promoteChunks:error]) {
    [self transition:@"failed" errorCode:@"AUDIO_CHUNK_INVALID"];
    return YES;
  }
  [self transition:self.requested ? @"failed" : @"off"
          errorCode:self.requested ? @"CAPTURE_EXITED" : nil];
  return YES;
}

- (void)stop {
  self.requested = NO;
  [self stopChild];
  NSError *error = nil;
  if ([self promoteChunks:&error]) [self transition:@"off" errorCode:nil];
  else [self transition:@"failed" errorCode:@"AUDIO_CHUNK_INVALID"];
}

@end
