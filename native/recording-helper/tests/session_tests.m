#import <Foundation/Foundation.h>
#import <signal.h>
#import <sys/wait.h>
#import <unistd.h>

#import "RHJournal.h"
#import "RHRecordingSession.h"

static void Require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static NSString *MeetingRoot(void) {
  NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-session-%@", NSUUID.UUID.UUIDString]];
  NSString *root = [base stringByAppendingPathComponent:NSUUID.UUID.UUIDString.lowercaseString];
  NSError *error = nil;
  Require([NSFileManager.defaultManager createDirectoryAtPath:root
                                  withIntermediateDirectories:YES
                                                   attributes:@{NSFilePosixPermissions: @0700}
                                                        error:&error],
          error.localizedDescription ?: @"meeting root must initialize");
  return root;
}

static NSArray<NSDictionary *> *Events(NSString *root) {
  NSString *eventsRoot = [root stringByAppendingPathComponent:@"control/events"];
  NSArray<NSString *> *names = [NSFileManager.defaultManager
      contentsOfDirectoryAtPath:eventsRoot error:nil] ?: @[];
  names = [names sortedArrayUsingComparator:^NSComparisonResult(NSString *left, NSString *right) {
    return @([left.stringByDeletingPathExtension integerValue]).integerValue <
        @([right.stringByDeletingPathExtension integerValue]).integerValue
        ? NSOrderedAscending : NSOrderedDescending;
  }];
  NSMutableArray *events = [NSMutableArray array];
  for (NSString *name in names) {
    if (![name.pathExtension isEqualToString:@"json"]) continue;
    NSData *data = [NSData dataWithContentsOfFile:[eventsRoot stringByAppendingPathComponent:name]];
    NSDictionary *event = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data
                                                                               options:0 error:nil];
    if (event != nil) [events addObject:event];
  }
  return events;
}

static NSDictionary *WaitForEvent(NSString *root, NSString *type,
                                  NSNumber *commandID, NSTimeInterval seconds) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (deadline.timeIntervalSinceNow > 0) {
    for (NSDictionary *event in Events(root)) {
      if ([event[@"type"] isEqualToString:type] &&
          (commandID == nil || [event[@"command_id"] isEqual:commandID])) return event;
    }
    usleep(20000);
  }
  return nil;
}

static NSDictionary *WaitForTrackState(NSString *root, NSString *track,
                                       NSString *state, NSTimeInterval seconds) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (deadline.timeIntervalSinceNow > 0) {
    for (NSDictionary *event in Events(root)) {
      if ([event[@"type"] isEqualToString:@"track_state"] &&
          [event[@"track"] isEqualToString:track] &&
          [event[@"state"] isEqualToString:state]) return event;
    }
    usleep(20000);
  }
  return nil;
}

static void Command(NSString *root, NSInteger identifier, NSString *action) {
  NSString *commands = [root stringByAppendingPathComponent:@"control/commands"];
  NSError *error = nil;
  Require(RHAtomicWriteJSON(@{
    @"schema_version": @1, @"command_id": @(identifier), @"action": action,
  }, [commands stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%ld.json", (long)identifier]], &error),
      error.localizedDescription ?: @"command must publish");
}

static int RunSessionChild(NSString *root, NSString *binaryRoot) {
  NSError *error = nil;
  RHRecordingSession *session = [[RHRecordingSession alloc]
      initWithSessionRoot:root
                meetingID:root.lastPathComponent
               binaryRoot:binaryRoot
    microphoneAuthorizer:^RHMicrophoneAuthorization { return RHMicrophoneAuthorizationGranted; }
                    error:&error];
  if (session == nil) {
    fprintf(stderr, "session init failed: %s:%ld\n",
            error.domain.UTF8String ?: "unknown", (long)error.code);
    return 70;
  }
  return [session run] ? 0 : 65;
}

static NSTask *StartSessionWithInvalidTail(NSString *root,
                                           NSString *binaryRoot,
                                           BOOL invalidTail) {
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments[0]];
  task.arguments = @[@"__session_child", root, binaryRoot];
  if (invalidTail) {
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"RH_FAKE_INVALID_TAIL"] = @"1";
    task.environment = environment;
  }
  NSError *error = nil;
  Require([task launchAndReturnError:&error], error.localizedDescription ?: @"session must start");
  return task;
}

static NSTask *StartSession(NSString *root, NSString *binaryRoot) {
  return StartSessionWithInvalidTail(root, binaryRoot, NO);
}

static NSTask *StartSessionWithInvalidOnlineTrack(NSString *root,
                                                   NSString *binaryRoot,
                                                   NSString *track) {
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments[0]];
  task.arguments = @[@"__session_child", root, binaryRoot];
  NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
  environment[@"RH_FAKE_INVALID_ONLINE_TRACK"] = track;
  task.environment = environment;
  NSError *error = nil;
  Require([task launchAndReturnError:&error], error.localizedDescription ?: @"session must start");
  return task;
}

static void TestInvalidHelperStateFailsClosed(NSString *binaryRoot) {
  NSArray *states = @[
    @{@"schema_version": @YES, @"last_command_id": @0},
    @{@"schema_version": @1, @"last_command_id": @YES},
    @{@"schema_version": @1, @"last_command_id": @1.5},
    @{@"schema_version": @1, @"last_command_id": @9007199254740992LL},
  ];
  for (NSDictionary *state in states) {
    NSString *root = MeetingRoot();
    NSString *control = [root stringByAppendingPathComponent:@"control"];
    NSError *error = nil;
    Require(RHEnsureOwnerDirectory(control, &error), @"control fixture must initialize");
    Require(RHAtomicWriteJSON(state,
                              [control stringByAppendingPathComponent:@"helper-state.json"],
                              &error),
            @"helper state fixture must publish");
    RHRecordingSession *session = [[RHRecordingSession alloc]
        initWithSessionRoot:root
                  meetingID:root.lastPathComponent
                 binaryRoot:binaryRoot
      microphoneAuthorizer:^RHMicrophoneAuthorization {
        return RHMicrophoneAuthorizationGranted;
      }
                      error:&error];
    Require(session == nil, @"invalid helper state numbers must fail closed");
    [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent
                                             error:nil];
  }
}

static void TestHelperStateRejectsSymlink(NSString *binaryRoot) {
  NSString *root = MeetingRoot();
  NSString *control = [root stringByAppendingPathComponent:@"control"];
  NSString *externalRoot = [root.stringByDeletingLastPathComponent
      stringByAppendingPathComponent:@"external-state"];
  NSString *external = [externalRoot stringByAppendingPathComponent:@"state.json"];
  NSError *error = nil;
  Require(RHEnsureOwnerDirectory(control, &error) &&
              RHEnsureOwnerDirectory(externalRoot, &error),
          @"helper state symlink fixture roots must initialize");
  Require(RHAtomicWriteJSON(@{@"schema_version": @1, @"last_command_id": @0},
                            external, &error),
          @"external helper state fixture must publish");
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:
      [control stringByAppendingPathComponent:@"helper-state.json"]
                                             withDestinationPath:external error:&error],
          @"helper state symlink fixture must initialize");
  RHRecordingSession *session = [[RHRecordingSession alloc]
      initWithSessionRoot:root meetingID:root.lastPathComponent binaryRoot:binaryRoot
      microphoneAuthorizer:^RHMicrophoneAuthorization {
        return RHMicrophoneAuthorizationGranted;
      } error:&error];
  Require(session == nil, @"helper state validation must reject a symbolic link");
  [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent
                                           error:nil];
}

static void TestCommandLifecycle(NSString *binaryRoot) {
  NSString *root = MeetingRoot();
  NSTask *helper = StartSession(root, binaryRoot);
  Require(WaitForEvent(root, @"helper_ready", nil, 3) != nil, @"helper must become ready");

  NSString *partial = [root stringByAppendingPathComponent:@"control/commands/.1.json.tmp"];
  [@"{\"schema_version\":" writeToFile:partial atomically:NO
                                  encoding:NSUTF8StringEncoding error:nil];
  usleep(200000);
  Require(helper.isRunning, @"partial temporary command must be ignored");

  Command(root, 1, @"mic_off");
  Require(WaitForEvent(root, @"command_applied", @1, 3) != nil,
          @"mic_off must be acknowledged");
  Command(root, 1, @"mic_on");
  usleep(200000);
  Command(root, 2, @"mic_off");
  NSDictionary *second = WaitForEvent(root, @"command_applied", @2, 3);
  Require([second[@"tracks"][@"mic"][@"state"] isEqualToString:@"off"],
          @"replaced duplicate id must not reapply a different action");
  Command(root, 3, @"system_off");
  Require(WaitForEvent(root, @"command_applied", @3, 3) != nil && helper.isRunning,
          @"both-off must keep the session alive");
  Command(root, 4, @"mic_on");
  Require(WaitForEvent(root, @"command_applied", @4, 3) != nil,
          @"mic must restart after both-off");
  Command(root, 5, @"stop");
  Require(WaitForEvent(root, @"helper_stopped", nil, 3) != nil,
          @"stop must publish terminal event");
  [helper waitUntilExit];
  Require(helper.terminationStatus == 0, @"normal stop must exit zero");
  [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent error:nil];
}

static void TestSequenceGapFailsClosed(NSString *binaryRoot) {
  NSString *root = MeetingRoot();
  NSTask *helper = StartSession(root, binaryRoot);
  Require(WaitForEvent(root, @"helper_ready", nil, 3) != nil, @"helper must become ready");
  Command(root, 2, @"stop");
  NSDictionary *failed = WaitForEvent(root, @"helper_failed", nil, 3);
  Require([failed[@"error_code"] isEqualToString:@"COMMAND_SEQUENCE_INVALID"],
          @"jumped command id must fail closed with stable code");
  [helper waitUntilExit];
  Require(helper.terminationStatus != 0, @"invalid journal must fail helper");
  [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent error:nil];
}

static void TestStopTailFailureIsNotNormalStop(NSString *binaryRoot) {
  NSString *root = MeetingRoot();
  NSTask *helper = StartSessionWithInvalidTail(root, binaryRoot, YES);
  Require(WaitForEvent(root, @"helper_ready", nil, 3) != nil, @"helper must become ready");
  Command(root, 1, @"stop");
  NSDictionary *ack = WaitForEvent(root, @"command_applied", @1, 3);
  Require([ack[@"result"] isEqualToString:@"error"],
          @"stop with an invalid tail must return an error ack");
  Require(WaitForEvent(root, @"helper_failed", nil, 3) != nil,
          @"invalid stop tail must terminate as helper_failed");
  [helper waitUntilExit];
  Require(helper.terminationStatus != 0, @"invalid stop tail must exit nonzero");
  Require(WaitForEvent(root, @"helper_stopped", nil, 0.1) == nil,
          @"invalid stop tail must never publish a normal stop");
  [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent error:nil];
}

static void TestInvalidOnlineChunkKeepsHealthyTrackRunning(NSString *binaryRoot) {
  NSString *root = MeetingRoot();
  NSTask *helper = StartSessionWithInvalidOnlineTrack(root, binaryRoot, @"mic");
  Require(WaitForEvent(root, @"helper_ready", nil, 3) != nil, @"helper must become ready");
  NSDictionary *failedTrack = WaitForTrackState(root, @"mic", @"failed", 3);
  Require([failedTrack[@"track"] isEqualToString:@"mic"] &&
              [failedTrack[@"state"] isEqualToString:@"failed"] &&
              [failedTrack[@"error_code"] isEqualToString:@"AUDIO_CHUNK_INVALID"],
          @"invalid online chunk must fail only its source track");
  Require(helper.isRunning && WaitForEvent(root, @"helper_failed", nil, 0.2) == nil,
          @"helper must continue while the other requested track is healthy");
  Command(root, 1, @"stop");
  Require(WaitForEvent(root, @"helper_failed", nil, 3) != nil,
          @"strict stop must fail when an invalid tail remains");
  [helper waitUntilExit];
  Require(helper.terminationStatus != 0, @"invalid final audio must exit nonzero");
  [NSFileManager.defaultManager removeItemAtPath:root.stringByDeletingLastPathComponent error:nil];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 4 && strcmp(argv[1], "__session_child") == 0) {
      return RunSessionChild([NSString stringWithUTF8String:argv[2]],
                             [NSString stringWithUTF8String:argv[3]]);
    }
    Require(argc == 2, @"session tests require fake binary root");
    NSString *binaryRoot = [NSString stringWithUTF8String:argv[1]];
    TestInvalidHelperStateFailsClosed(binaryRoot);
    TestHelperStateRejectsSymlink(binaryRoot);
    TestCommandLifecycle(binaryRoot);
    TestSequenceGapFailsClosed(binaryRoot);
    TestStopTailFailureIsNotNormalStop(binaryRoot);
    TestInvalidOnlineChunkKeepsHealthyTrackRunning(binaryRoot);
    puts("{\"session_tests\":\"passed\"}");
    return 0;
  }
}
