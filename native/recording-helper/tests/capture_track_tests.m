#import <Foundation/Foundation.h>
#import <signal.h>
#import <unistd.h>

#import "RHCaptureTrack.h"
#import "RHProcessRegistry.h"

static void Require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static BOOL WaitForState(RHCaptureTrack *track, NSString *state, NSTimeInterval seconds) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (deadline.timeIntervalSinceNow > 0) {
    [track refresh:nil];
    if ([track.state isEqualToString:state]) return YES;
    usleep(20000);
  }
  return NO;
}

static void TestInvalidOnlineChunkOnlyFailsItsTrack(NSString *binaryRoot) {
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-track-invalid-%@", NSUUID.UUID.UUIDString]];
  NSString *control = [root stringByAppendingPathComponent:@"control"];
  NSString *recording = [root stringByAppendingPathComponent:@"recording"];
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc]
      initWithControlRoot:control allowedBinaryRoot:binaryRoot error:&error];
  Require(registry != nil, error.localizedDescription ?: @"registry must initialize");
  RHCaptureTrack *mic = [[RHCaptureTrack alloc]
      initWithName:@"mic" recordingRoot:recording binaryRoot:binaryRoot
      registry:registry chunkHandler:nil stateHandler:nil error:&error];
  RHCaptureTrack *system = [[RHCaptureTrack alloc]
      initWithName:@"system" recordingRoot:recording binaryRoot:binaryRoot
      registry:registry chunkHandler:nil stateHandler:nil error:&error];
  Require(mic != nil && system != nil, @"isolated tracks must initialize");
  setenv("RH_FAKE_INVALID_ONLINE_TRACK", "mic", 1);
  Require([mic requestOn:&error] && [system requestOn:&error], @"isolated tracks must start");
  unsetenv("RH_FAKE_INVALID_ONLINE_TRACK");

  BOOL handled = YES;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while (deadline.timeIntervalSinceNow > 0 && ![mic.state isEqualToString:@"failed"]) {
    error = nil;
    handled = [mic refresh:&error];
    [system refresh:nil];
    if (!handled) break;
    usleep(20000);
  }
  Require(handled && [mic.errorCode isEqualToString:@"AUDIO_CHUNK_INVALID"],
          @"bad online audio must be a handled track-local failure");
  Require([system.state isEqualToString:@"on"], @"the healthy track must remain on");
  [mic stop];
  [system stop];
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestSilentSystemDoesNotClaimPermissionDenial(NSString *binaryRoot) {
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-signal-%@", NSUUID.UUID.UUIDString]];
  RHProcessRegistry *registry = [[RHProcessRegistry alloc]
      initWithControlRoot:[root stringByAppendingPathComponent:@"control"]
      allowedBinaryRoot:binaryRoot error:nil];
  RHCaptureTrack *system = [[RHCaptureTrack alloc] initWithName:@"system"
      recordingRoot:[root stringByAppendingPathComponent:@"recording"] binaryRoot:binaryRoot
      registry:registry chunkHandler:nil stateHandler:nil error:nil];
  RHCaptureTrack *mic = [[RHCaptureTrack alloc] initWithName:@"mic"
      recordingRoot:[root stringByAppendingPathComponent:@"recording"] binaryRoot:binaryRoot
      registry:registry chunkHandler:nil stateHandler:nil error:nil];
  setenv("RH_FAKE_SILENT_START", "1", 1);
  Require([system requestOn:nil] && [mic requestOn:nil], @"signal fixtures must start");
  Require(WaitForState(system, @"on", 0.8), @"silent system capture must stay running");
  Require([system.errorCode isEqualToString:@"SYSTEM_AUDIO_NO_SIGNAL"],
          @"all-zero system PCM must report no signal, not permission denial");
  pid_t pid = system.processID;
  Require(WaitForState(mic, @"on", 0.5) && mic.errorCode == nil,
          @"microphone silence must not receive a system warning");
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while (system.errorCode != nil && deadline.timeIntervalSinceNow > 0) {
    [system refresh:nil];
    usleep(20000);
  }
  Require(system.errorCode == nil && system.processID == pid && system.requested,
          @"nonzero PCM must clear the warning without restarting capture");
  [system requestOff:nil];
  Require(system.errorCode == nil && !system.requested, @"off must clear the warning");
  Require([system requestOn:nil] && WaitForState(system, @"on", 0.8) &&
              [system.errorCode isEqualToString:@"SYSTEM_AUDIO_NO_SIGNAL"],
          @"retry must reset signal observation");
  unsetenv("RH_FAKE_SILENT_START");
  [system stop];
  [mic stop];
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    Require(argc == 2, @"capture track tests require fake binary root");
    NSString *binaryRoot = [NSString stringWithUTF8String:argv[1]];
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"recording-helper-track-%@", NSUUID.UUID.UUIDString]];
    NSString *control = [root stringByAppendingPathComponent:@"control"];
    NSString *recording = [root stringByAppendingPathComponent:@"recording"];
    NSError *error = nil;
    RHProcessRegistry *registry = [[RHProcessRegistry alloc]
        initWithControlRoot:control allowedBinaryRoot:binaryRoot error:&error];
    Require(registry != nil, error.localizedDescription ?: @"registry must initialize");
    RHCaptureTrack *mic = [[RHCaptureTrack alloc]
        initWithName:@"mic" recordingRoot:recording binaryRoot:binaryRoot
        registry:registry chunkHandler:nil stateHandler:nil error:&error];
    RHCaptureTrack *system = [[RHCaptureTrack alloc]
        initWithName:@"system" recordingRoot:recording binaryRoot:binaryRoot
        registry:registry chunkHandler:nil stateHandler:nil error:&error];
    Require(mic != nil && system != nil, error.localizedDescription ?: @"tracks must initialize");

    Require([mic requestOn:&error] && [system requestOn:&error],
            error.localizedDescription ?: @"both tracks must start");
    Require(WaitForState(mic, @"on", 2) && WaitForState(system, @"on", 2),
            @"both tracks must report on from child readiness");
    Require([mic requestOn:&error], @"duplicate on must be idempotent");
    pid_t firstMicPID = mic.processID;
    Require(firstMicPID > 1, @"mic PID must be visible to the watchdog registry");
    kill(firstMicPID, SIGKILL);
    Require(WaitForState(mic, @"failed", 2), @"crashed mic must become failed");
    [system refresh:&error];
    Require([system.state isEqualToString:@"on"], @"mic crash must not stop system");
    Require([mic requestOn:&error] && WaitForState(mic, @"on", 2),
            @"explicit mic_on must retry a failed track");

    pid_t firstSystemPID = system.processID;
    Require(firstSystemPID > 1, @"system PID must be visible to the watchdog registry");
    kill(firstSystemPID, SIGKILL);
    Require(WaitForState(system, @"failed", 2), @"crashed system track must become failed");
    [mic refresh:&error];
    Require([mic.state isEqualToString:@"on"], @"system crash must not stop mic");
    Require([system requestOn:&error] && WaitForState(system, @"on", 2),
            @"explicit system_on must retry a failed track");

    Require([mic requestOff:&error] && [mic requestOff:&error],
            @"duplicate off must be idempotent");
    Require([mic.state isEqualToString:@"off"] && !mic.requested,
            @"off must clear requested state");
    NSArray *micChunks = [NSFileManager.defaultManager contentsOfDirectoryAtPath:
        [recording stringByAppendingPathComponent:@"mic/chunks"] error:&error];
    Require(micChunks.count >= 2, @"graceful off must preserve closed short tail");
    Require([system requestOff:&error], @"system must stop independently");
    [NSFileManager.defaultManager removeItemAtPath:root error:nil];
    TestInvalidOnlineChunkOnlyFailsItsTrack(binaryRoot);
    TestSilentSystemDoesNotClaimPermissionDenial(binaryRoot);
    puts("{\"capture_track_tests\":\"passed\"}");
    return 0;
  }
}
