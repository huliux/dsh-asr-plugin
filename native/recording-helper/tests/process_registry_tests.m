#import <Foundation/Foundation.h>
#import <signal.h>
#import <sys/wait.h>
#import <unistd.h>

#import "RHJournal.h"
#import "RHProcessRegistry.h"

static void Require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static pid_t StartSleep(void) {
  pid_t pid = fork();
  if (pid == 0) {
    execl("/bin/sleep", "sleep", "30", NULL);
    _exit(127);
  }
  Require(pid > 0, @"sleep child must start");
  usleep(100000);
  return pid;
}

static BOOL IsAlive(pid_t pid) {
  return kill(pid, 0) == 0;
}

static void Reap(pid_t pid) {
  kill(pid, SIGKILL);
  waitpid(pid, NULL, 0);
}

static RHProcessIdentity Identity(pid_t pid) {
  RHProcessIdentity identity = {};
  Require(RHReadProcessIdentity(pid, &identity), @"process identity must be readable");
  return identity;
}

static NSString *TemporaryRoot(void) {
  return [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-pids-%@", NSUUID.UUID.UUIDString]];
}

static void TestInvalidRegistryNumbers(void) {
  NSArray *registries = @[
    @{@"schema_version": @YES, @"tracks": @{}},
    @{@"schema_version": @1, @"tracks": @{
      @"mic": @{@"pid": @2.5, @"binary_path": @"/bin/sleep"},
    }},
    @{@"schema_version": @1, @"tracks": @{
      @"mic": @{@"pid": @YES, @"binary_path": @"/bin/sleep"},
    }},
    @{@"schema_version": @1, @"tracks": @{
      @"mic": @{@"pid": @2147483648LL, @"binary_path": @"/bin/sleep"},
    }},
  ];
  for (NSDictionary *value in registries) {
    NSString *root = TemporaryRoot();
    NSError *error = nil;
    Require(RHEnsureOwnerDirectory(root, &error), @"registry fixture must initialize");
    Require(RHAtomicWriteJSON(value, [root stringByAppendingPathComponent:@"capture-pids.json"],
                              &error),
            @"registry fixture must publish");
    RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                               allowedBinaryRoot:@"/bin"
                                                                           error:&error];
    Require(registry == nil, @"invalid PID registry numbers must fail closed");
    [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  }
}

static void TestRegistryRejectsSymlink(void) {
  NSString *root = TemporaryRoot();
  NSString *externalRoot = TemporaryRoot();
  NSString *external = [externalRoot stringByAppendingPathComponent:@"capture-pids.json"];
  NSError *error = nil;
  Require(RHEnsureOwnerDirectory(root, &error) &&
              RHEnsureOwnerDirectory(externalRoot, &error),
          @"registry symlink fixture roots must initialize");
  Require(RHAtomicWriteJSON(@{@"schema_version": @1, @"tracks": @{}}, external, &error),
          @"external registry fixture must publish");
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:
      [root stringByAppendingPathComponent:@"capture-pids.json"]
                                             withDestinationPath:external error:&error],
          @"registry symlink fixture must initialize");
  RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                             allowedBinaryRoot:@"/bin"
                                                                         error:&error];
  Require(registry == nil, @"PID registry validation must reject a symbolic link");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  [NSFileManager.defaultManager removeItemAtPath:externalRoot error:nil];
}

static void TestScopedRecovery(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                            allowedBinaryRoot:@"/bin"
                                                                        error:&error];
  Require(registry != nil, error.localizedDescription ?: @"registry must initialize");
  pid_t tracked = StartSleep();
  pid_t unrelated = StartSleep();
  Require([registry setPID:tracked binaryPath:@"/bin/sleep" forTrack:@"mic" error:&error],
          error.localizedDescription ?: @"tracked child must persist");
  Require([registry stopTrackedProcessesWithError:&error] == 1,
          error.localizedDescription ?: @"one tracked child must stop");
  waitpid(tracked, NULL, 0);
  Require(IsAlive(unrelated), @"unregistered process must remain alive");
  Reap(unrelated);
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestStaleIdentityDoesNotStopSameBinary(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                            allowedBinaryRoot:@"/bin"
                                                                        error:&error];
  Require(registry != nil, @"registry must initialize for PID reuse fixture");
  pid_t unrelated = StartSleep();
  Require(RHAtomicWriteJSON(@{
    @"schema_version": @1,
    @"tracks": @{
      @"mic": @{
        @"pid": @(unrelated),
        @"binary_path": @"/bin/sleep",
        @"start_sec": @1,
        @"start_usec": @0,
      },
    },
  }, [root stringByAppendingPathComponent:@"capture-pids.json"], &error),
          @"stale PID identity fixture must publish");
  error = nil;
  Require([registry stopTrackedProcessesWithError:&error] == 0 && error == nil,
          @"valid stale identity must converge without a registry error");
  Require(IsAlive(unrelated),
          @"PID reuse by the same binary must not stop a different process lifetime");
  Reap(unrelated);
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestWatchdogNormalAndCrashPaths(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                            allowedBinaryRoot:@"/bin"
                                                                        error:&error];
  pid_t helper = StartSleep();
  pid_t host = StartSleep();
  pid_t normal = StartSleep();
  Require([registry setPID:normal binaryPath:@"/bin/sleep" forTrack:@"system" error:&error],
          @"normal child must persist");
  Require(RHMarkNormalStop(root, &error), @"normal marker must publish");
  Require(RHRunWatchdog(Identity(helper), Identity(host), root, @"/bin") == 0 &&
              IsAlive(helper) && IsAlive(host) && IsAlive(normal),
          @"normal stop marker must suppress watchdog kill");
  Reap(helper);
  Reap(host);
  Reap(normal);

  [NSFileManager.defaultManager removeItemAtPath:RHNormalStopPath(root) error:nil];
  helper = StartSleep();
  host = StartSleep();
  pid_t orphan = StartSleep();
  Require([registry setPID:orphan binaryPath:@"/bin/sleep" forTrack:@"mic" error:&error],
          @"orphan must persist");
  RHProcessIdentity helperIdentity = Identity(helper);
  RHProcessIdentity hostIdentity = Identity(host);
  Reap(host);
  Require(RHRunWatchdog(helperIdentity, hostIdentity, root, @"/bin") == 0,
          @"host death watchdog must converge");
  waitpid(helper, NULL, 0);
  waitpid(orphan, NULL, 0);
  Require(!IsAlive(helper), @"host death must stop the helper");
  Require(!IsAlive(orphan), @"watchdog must stop only the registered orphan");

  helper = StartSleep();
  host = StartSleep();
  orphan = StartSleep();
  Require([registry setPID:orphan binaryPath:@"/bin/sleep" forTrack:@"system" error:&error],
          @"helper crash orphan must persist");
  helperIdentity = Identity(helper);
  hostIdentity = Identity(host);
  Reap(helper);
  Require(RHRunWatchdog(helperIdentity, hostIdentity, root, @"/bin") == 0,
          @"helper death watchdog must converge");
  waitpid(orphan, NULL, 0);
  Require(IsAlive(host), @"helper death must not stop the host");
  Reap(host);

  helper = StartSleep();
  host = StartSleep();
  helperIdentity = Identity(helper);
  hostIdentity = Identity(host);
  Require([@"corrupt" writeToFile:[root stringByAppendingPathComponent:@"capture-pids.json"]
                          atomically:YES encoding:NSUTF8StringEncoding error:&error],
          @"corrupt registry fixture must persist");
  Reap(host);
  Require(RHRunWatchdog(helperIdentity, hostIdentity, root, @"/bin") == 70,
          @"corrupt registry must fail closed");
  waitpid(helper, NULL, 0);
  Require(!IsAlive(helper), @"registry corruption must not leave a live helper after Host death");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestCancellationStopsDetachedHelper(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc] initWithControlRoot:root
                                                            allowedBinaryRoot:@"/bin" error:&error];
  Require(registry != nil, @"cancellation registry must initialize");
  pid_t helper = fork();
  if (helper == 0) {
    signal(SIGTERM, SIG_IGN);
    while (YES) pause();
  }
  Require(helper > 0, @"blocked helper must start");
  usleep(100000);
  pid_t host = StartSleep();
  pid_t capture = StartSleep();
  Require([registry setPID:capture binaryPath:@"/bin/sleep" forTrack:@"mic" error:&error],
          @"capture must be registered");
  RHProcessIdentity helperIdentity = Identity(helper);
  RHProcessIdentity hostIdentity = Identity(host);
  pid_t watchdog = fork();
  if (watchdog == 0) _exit(RHRunWatchdog(helperIdentity, hostIdentity, root, @"/bin"));
  Require(watchdog > 0, @"watchdog must start");
  Require(RHAtomicWriteJSON(@{@"schema_version": @1, @"cancel": @YES},
                           [root stringByAppendingPathComponent:@"host-cancel.json"], &error),
          @"host cancellation must publish");
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6.0];
  int status = 0;
  BOOL finished = NO;
  while (deadline.timeIntervalSinceNow > 0) {
    waitpid(helper, NULL, WNOHANG);
    waitpid(capture, NULL, WNOHANG);
    if (waitpid(watchdog, &status, WNOHANG) == watchdog) { finished = YES; break; }
    usleep(10000);
  }
  BOOL quiet = !IsAlive(helper) && !IsAlive(capture) && IsAlive(host);
  BOOL acknowledged = [NSFileManager.defaultManager fileExistsAtPath:
      [root stringByAppendingPathComponent:@"host-cancelled.json"]];
  Reap(helper); Reap(capture); Reap(host);
  if (!finished) Reap(watchdog);
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  Require(finished && WIFEXITED(status) && WEXITSTATUS(status) == 0 && quiet && acknowledged,
          @"cancellation must stop blocked helper and capture while preserving the Host");
}

static void TestCancellationPreservesStaleHelperIdentity(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  Require(RHEnsureOwnerDirectory(root, &error), @"stale helper fixture must initialize");
  pid_t unrelated = StartSleep();
  pid_t host = StartSleep();
  RHProcessIdentity stale = Identity(unrelated);
  stale.startSeconds -= 1;
  Require(RHAtomicWriteJSON(@{@"schema_version": @1, @"cancel": @YES},
      [root stringByAppendingPathComponent:@"host-cancel.json"], &error), @"cancel must publish");
  int result = RHRunWatchdog(stale, Identity(host), root, @"/bin");
  BOOL preserved = IsAlive(unrelated) && IsAlive(host);
  Reap(unrelated);
  Reap(host);
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  Require(result == 0 && preserved, @"stale helper lifetime must never signal an unrelated process");
}

static void TestInvalidCancellationIsIgnored(void) {
  for (NSString *kind in @[@"schema", @"number", @"symlink"]) {
    NSString *root = TemporaryRoot();
    NSError *error = nil;
    Require(RHEnsureOwnerDirectory(root, &error), @"invalid cancellation fixture must initialize");
    NSString *request = [root stringByAppendingPathComponent:@"host-cancel.json"];
    NSString *external = [root stringByAppendingPathComponent:@"external.json"];
    NSDictionary *payload = @{@"schema_version": [kind isEqualToString:@"schema"] ? @YES : @1,
        @"cancel": [kind isEqualToString:@"number"] ? @1 : @YES};
    Require(RHAtomicWriteJSON(payload, [kind isEqualToString:@"symlink"] ? external : request, &error),
        @"invalid request must publish");
    if ([kind isEqualToString:@"symlink"]) {
      Require(symlink(external.fileSystemRepresentation, request.fileSystemRepresentation) == 0,
          @"cancellation symlink must initialize");
    }
    pid_t helper = StartSleep();
    pid_t host = StartSleep();
    RHProcessIdentity helperIdentity = Identity(helper);
    RHProcessIdentity hostIdentity = Identity(host);
    pid_t watchdog = fork();
    if (watchdog == 0) _exit(RHRunWatchdog(helperIdentity, hostIdentity, root, @"/bin"));
    Require(watchdog > 0, @"invalid request watchdog must start");
    usleep(250000);
    BOOL ignored = IsAlive(helper) && IsAlive(host) && IsAlive(watchdog) &&
        ![NSFileManager.defaultManager fileExistsAtPath:
          [root stringByAppendingPathComponent:@"host-cancelled.json"]];
    Reap(watchdog);
    Reap(helper);
    Reap(host);
    [NSFileManager.defaultManager removeItemAtPath:root error:nil];
    Require(ignored, @"unsafe cancellation must not signal any process or acknowledge cleanup");
  }
}

int main(void) {
  @autoreleasepool {
    TestInvalidRegistryNumbers();
    TestRegistryRejectsSymlink();
    TestScopedRecovery();
    TestStaleIdentityDoesNotStopSameBinary();
    TestWatchdogNormalAndCrashPaths();
    TestCancellationStopsDetachedHelper();
    TestCancellationPreservesStaleHelperIdentity();
    TestInvalidCancellationIsIgnored();
    puts("{\"process_registry_tests\":\"passed\"}");
    return 0;
  }
}
