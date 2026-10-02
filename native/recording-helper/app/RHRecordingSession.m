#import "RHRecordingSession.h"

#import "RHCaptureTrack.h"
#import "RHChunkStore.h"
#import "RHJournal.h"
#import "RHProcessRegistry.h"

#import <errno.h>
#import <sys/stat.h>
#import <unistd.h>

static NSString *const RHSessionErrorDomain = @"com.bitbook.dsh-asr.recording-helper.session";

static NSError *RHSessionError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:RHSessionErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface RHRecordingSession ()
@property(nonatomic, readonly) NSString *commandsRoot;
@property(nonatomic, readonly) NSString *controlRoot;
@property(nonatomic, readonly) NSString *helperStatePath;
@property(nonatomic, readonly) NSString *meetingID;
@property(nonatomic, readonly) NSString *sessionRoot;
@property(nonatomic, readonly) RHEventJournal *events;
@property(nonatomic, readonly) RHProcessRegistry *registry;
@property(nonatomic, readonly) RHCaptureTrack *mic;
@property(nonatomic, readonly) RHCaptureTrack *system;
@property(nonatomic, readonly) RHMicrophoneAuthorizer microphoneAuthorizer;
@property(nonatomic) NSInteger expectedCommandID;
@property(nonatomic) BOOL journalFailed;
@end

@implementation RHRecordingSession

- (instancetype)initWithSessionRoot:(NSString *)sessionRoot
                            meetingID:(NSString *)meetingID
                           binaryRoot:(NSString *)binaryRoot
                microphoneAuthorizer:(RHMicrophoneAuthorizer)microphoneAuthorizer
                                error:(NSError **)error {
  self = [super init];
  if (self == nil) return nil;
  _sessionRoot = [sessionRoot copy];
  _meetingID = [meetingID copy];
  _microphoneAuthorizer = [microphoneAuthorizer copy];
  _controlRoot = [sessionRoot stringByAppendingPathComponent:@"control"];
  _commandsRoot = [_controlRoot stringByAppendingPathComponent:@"commands"];
  _helperStatePath = [_controlRoot stringByAppendingPathComponent:@"helper-state.json"];
  NSString *recordingRoot = [sessionRoot stringByAppendingPathComponent:@"recording"];
  if (!RHEnsureOwnerDirectory(_controlRoot, error) ||
      !RHEnsureOwnerDirectory(_commandsRoot, error) ||
      !RHEnsureOwnerDirectory(recordingRoot, error)) return nil;
  _events = [[RHEventJournal alloc] initWithControlRoot:_controlRoot error:error];
  _registry = [[RHProcessRegistry alloc] initWithControlRoot:_controlRoot
                                          allowedBinaryRoot:binaryRoot error:error];
  if (_events == nil || _registry == nil) return nil;
  [_registry stopTrackedProcessesWithError:error];
  if (error != nil && *error != nil) return nil;
  [NSFileManager.defaultManager removeItemAtPath:RHNormalStopPath(_controlRoot) error:nil];
  NSInteger lastCommandID = [self loadLastCommandID:error];
  if (lastCommandID < 0) return nil;
  _expectedCommandID = lastCommandID + 1;

  __weak RHRecordingSession *weakSelf = self;
  RHTrackStateHandler stateHandler = ^(NSDictionary<NSString *, id> *snapshot) {
    RHRecordingSession *strongSelf = weakSelf;
    if (strongSelf == nil) return;
    NSError *eventError = nil;
    if (![strongSelf.events appendType:@"track_state" fields:snapshot error:&eventError]) {
      strongSelf.journalFailed = YES;
    }
  };
  RHChunkHandler chunkHandler = ^(RHChunkMetadata *chunk, NSString *track) {
    RHRecordingSession *strongSelf = weakSelf;
    if (strongSelf == nil) return;
    NSError *eventError = nil;
    NSDictionary *fields = @{
      @"track": track,
      @"start_us": @(chunk.startUs),
      @"end_us": @(chunk.endUs),
      @"frame_count": @(chunk.frameCount),
    };
    if (![strongSelf.events appendType:@"chunk_closed" fields:fields error:&eventError]) {
      strongSelf.journalFailed = YES;
    }
  };
  _mic = [[RHCaptureTrack alloc] initWithName:@"mic" recordingRoot:recordingRoot
                                   binaryRoot:binaryRoot registry:_registry
                                  chunkHandler:chunkHandler stateHandler:stateHandler error:error];
  _system = [[RHCaptureTrack alloc] initWithName:@"system" recordingRoot:recordingRoot
                                      binaryRoot:binaryRoot registry:_registry
                                     chunkHandler:chunkHandler stateHandler:stateHandler error:error];
  if (_mic == nil || _system == nil) return nil;
  return self;
}

- (NSInteger)loadLastCommandID:(NSError **)error {
  struct stat metadata = {};
  if (lstat(self.helperStatePath.fileSystemRepresentation, &metadata) != 0) {
    if (errno != ENOENT) {
      if (error != nil) *error = RHSessionError(1, @"helper state cannot be inspected");
      return -1;
    }
    if (![self persistLastCommandID:0 error:error]) return -1;
    return 0;
  }
  NSData *data = RHReadJournalFile(self.helperStatePath, error);
  id parsed = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![parsed isKindOfClass:NSDictionary.class]) {
    if (error != nil && *error == nil) *error = RHSessionError(1, @"helper state is invalid");
    return -1;
  }
  NSDictionary *value = parsed;
  NSSet *keys = [NSSet setWithArray:@[@"schema_version", @"last_command_id"]];
  NSNumber *last = value[@"last_command_id"];
  if (![[NSSet setWithArray:value.allKeys] isEqualToSet:keys] ||
      !RHIsJSONInteger(value[@"schema_version"], 1, 1) ||
      !RHIsJSONInteger(last, 0, RHJSONSafeIntegerMaximum)) {
    if (error != nil) *error = RHSessionError(1, @"helper state is invalid");
    return -1;
  }
  return last.integerValue;
}

- (BOOL)persistLastCommandID:(NSInteger)identifier error:(NSError **)error {
  return RHAtomicWriteJSON(@{
    @"schema_version": @1, @"last_command_id": @(identifier),
  }, self.helperStatePath, error);
}

- (NSDictionary<NSString *, id> *)trackSnapshots {
  NSMutableDictionary *mic = [self.mic.snapshot mutableCopy];
  NSMutableDictionary *system = [self.system.snapshot mutableCopy];
  [mic removeObjectForKey:@"track"];
  [system removeObjectForKey:@"track"];
  return @{@"mic": mic, @"system": system};
}

- (BOOL)appendType:(NSString *)type fields:(NSDictionary *)fields {
  NSError *error = nil;
  BOOL written = [self.events appendType:type fields:fields error:&error];
  if (!written) self.journalFailed = YES;
  return written;
}

- (BOOL)startTracks:(NSError **)error {
  RHMicrophoneAuthorization microphone = self.microphoneAuthorizer();
  if (microphone == RHMicrophoneAuthorizationGranted) {
    if (![self.mic requestOn:error]) return NO;
  } else {
    NSString *code = microphone == RHMicrophoneAuthorizationDenied
        ? @"MICROPHONE_PERMISSION_DENIED" : @"MICROPHONE_PERMISSION_TIMEOUT";
    [self.mic markRequestedFailure:code];
  }
  if (![self.system requestOn:error]) return NO;
  return [self appendType:@"helper_ready" fields:@{
    @"meeting_id": self.meetingID,
    @"tracks": self.trackSnapshots,
  }];
}

- (NSData *)readCommandAtPath:(NSString *)path error:(NSError **)error {
  return RHReadJournalFile(path, error);
}

- (NSInteger)firstFutureCommandID {
  NSArray<NSString *> *names = [NSFileManager.defaultManager
      contentsOfDirectoryAtPath:self.commandsRoot error:nil] ?: @[];
  NSInteger future = NSIntegerMax;
  for (NSString *name in names) {
    if (![name.pathExtension isEqualToString:@"json"]) continue;
    NSScanner *scanner = [NSScanner scannerWithString:name.stringByDeletingPathExtension];
    NSInteger identifier = 0;
    if ([scanner scanInteger:&identifier] && scanner.isAtEnd && identifier > self.expectedCommandID) {
      future = MIN(future, identifier);
    }
  }
  return future;
}

- (BOOL)applyCommand:(RHCommand *)command
               error:(NSError **)error
            stopping:(BOOL *)stopping
             applied:(BOOL *)appliedResult {
  BOOL applied = YES;
  if ([command.action isEqualToString:@"mic_on"]) applied = [self.mic requestOn:error];
  else if ([command.action isEqualToString:@"mic_off"]) applied = [self.mic requestOff:error];
  else if ([command.action isEqualToString:@"system_on"]) applied = [self.system requestOn:error];
  else if ([command.action isEqualToString:@"system_off"]) applied = [self.system requestOff:error];
  else if ([command.action isEqualToString:@"stop"]) {
    BOOL micStopped = [self.mic requestOff:error];
    BOOL systemStopped = [self.system requestOff:error];
    applied = micStopped && systemStopped;
    *stopping = applied;
  }
  *appliedResult = applied;
  if (![self persistLastCommandID:command.commandID error:error]) return NO;
  self.expectedCommandID = command.commandID + 1;
  NSString *errorCode = applied ? nil : @"COMMAND_APPLY_FAILED";
  return [self appendType:@"command_applied" fields:@{
    @"command_id": @(command.commandID),
    @"result": applied ? @"ok" : @"error",
    @"error_code": errorCode ?: NSNull.null,
    @"tracks": self.trackSnapshots,
  }];
}

- (BOOL)failWithCode:(NSString *)code commandID:(NSInteger)commandID {
  if (commandID > 0) {
    [self appendType:@"command_applied" fields:@{
      @"command_id": @(commandID),
      @"result": @"error",
      @"error_code": code,
      @"tracks": self.trackSnapshots,
    }];
  }
  [self.mic stop];
  [self.system stop];
  [self appendType:@"helper_failed" fields:@{@"error_code": code}];
  RHMarkNormalStop(self.controlRoot, nil);
  return NO;
}

- (NSNumber *)processNextCommand:(BOOL *)stopping {
  NSString *path = [self.commandsRoot stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%ld.json", (long)self.expectedCommandID]];
  if (![NSFileManager.defaultManager fileExistsAtPath:path]) {
    NSInteger future = [self firstFutureCommandID];
    if (future != NSIntegerMax) {
      [self failWithCode:@"COMMAND_SEQUENCE_INVALID" commandID:future];
      return @NO;
    }
    return nil;
  }
  NSError *error = nil;
  NSData *data = [self readCommandAtPath:path error:&error];
  RHCommand *command = nil;
  NSString *code = nil;
  RHCommandDisposition disposition = data == nil ? RHCommandDispositionInvalid
      : RHParseCommandData(data, self.expectedCommandID, &command, &code);
  if (disposition != RHCommandDispositionApply || command == nil) {
    [self failWithCode:code ?: @"COMMAND_SCHEMA_INVALID"
             commandID:self.expectedCommandID];
    return @NO;
  }
  BOOL applied = NO;
  if (![self applyCommand:command error:&error stopping:stopping applied:&applied]) {
    [self failWithCode:@"COMMAND_APPLY_FAILED" commandID:command.commandID];
    return @NO;
  }
  if ([command.action isEqualToString:@"stop"] && !applied) {
    [self failWithCode:@"COMMAND_APPLY_FAILED" commandID:0];
    return @NO;
  }
  return @YES;
}

- (BOOL)allRequestedTracksFailed {
  NSArray<RHCaptureTrack *> *tracks = @[self.mic, self.system];
  NSUInteger requested = 0;
  NSUInteger failed = 0;
  for (RHCaptureTrack *track in tracks) {
    if (!track.requested) continue;
    requested += 1;
    if ([track.state isEqualToString:@"failed"]) failed += 1;
  }
  return requested > 0 && failed == requested;
}

- (BOOL)run {
  return [self runUntil:^BOOL { return NO; }];
}

- (BOOL)runUntil:(BOOL (^)(void))shouldStop {
  NSError *error = nil;
  if (![self startTracks:&error]) return [self failWithCode:@"HELPER_START_FAILED" commandID:0];
  while (!shouldStop()) {
    if (![self.mic refresh:&error] || ![self.system refresh:&error] || self.journalFailed) {
      return [self failWithCode:@"HELPER_IO_FAILED" commandID:0];
    }
    if ([self allRequestedTracksFailed]) {
      return [self failWithCode:@"ALL_REQUESTED_TRACKS_FAILED" commandID:0];
    }
    BOOL stopping = NO;
    NSNumber *processed = [self processNextCommand:&stopping];
    if (processed != nil && !processed.boolValue) return NO;
    if (stopping) {
      [self appendType:@"helper_stopped" fields:@{@"reason": @"command"}];
      RHMarkNormalStop(self.controlRoot, nil);
      return !self.journalFailed;
    }
    usleep(100000);
  }
  [self.mic stop];
  [self.system stop];
  [self appendType:@"helper_stopped" fields:@{@"reason": @"signal"}];
  RHMarkNormalStop(self.controlRoot, nil);
  return !self.journalFailed;
}

@end
