#import "RHProcessRegistry.h"

#import "RHJournal.h"

#import <errno.h>
#import <libproc.h>
#import <limits.h>
#import <signal.h>
#import <sys/proc.h>
#import <sys/proc_info.h>
#import <sys/stat.h>
#import <unistd.h>

static NSString *const RHRegistryErrorDomain =
    @"com.bitbook.dsh-asr.recording-helper.process-registry";

static NSError *RHRegistryError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:RHRegistryErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *RHCanonicalPath(NSString *path) {
  char resolved[PATH_MAX] = {0};
  if (realpath(path.fileSystemRepresentation, resolved) == NULL) return nil;
  return [NSString stringWithUTF8String:resolved];
}

static BOOL RHPathIsWithin(NSString *path, NSString *root) {
  return [path isEqualToString:root] ||
      [path hasPrefix:[root stringByAppendingString:@"/"]];
}

static BOOL RHProcessExists(pid_t pid) {
  return pid > 1 && (kill(pid, 0) == 0 || errno == EPERM);
}

BOOL RHReadProcessIdentity(pid_t processID, RHProcessIdentity *identity) {
  if (processID <= 1 || identity == NULL) return NO;
  struct proc_bsdinfo info = {};
  int bytes = proc_pidinfo(processID, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes != sizeof(info) || info.pbi_start_tvsec == 0 ||
      info.pbi_start_tvusec > 999999 || info.pbi_uid != geteuid() ||
      info.pbi_status == SZOMB) return NO;
  identity->processID = processID;
  identity->startSeconds = info.pbi_start_tvsec;
  identity->startMicroseconds = info.pbi_start_tvusec;
  return YES;
}

BOOL RHProcessIdentityIsAlive(RHProcessIdentity identity) {
  RHProcessIdentity current = {};
  return RHProcessExists(identity.processID) &&
      RHReadProcessIdentity(identity.processID, &current) &&
      current.startSeconds == identity.startSeconds &&
      current.startMicroseconds == identity.startMicroseconds;
}

static BOOL RHProcessStartTime(pid_t pid,
                               unsigned long long *seconds,
                               unsigned long long *microseconds) {
  RHProcessIdentity identity = {};
  if (!RHReadProcessIdentity(pid, &identity)) return NO;
  *seconds = identity.startSeconds;
  *microseconds = identity.startMicroseconds;
  return YES;
}

static BOOL RHProcessMatches(NSDictionary *entry) {
  pid_t pid = [entry[@"pid"] intValue];
  char actual[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (!RHProcessExists(pid) || proc_pidpath(pid, actual, sizeof(actual)) <= 0) return NO;
  NSString *actualPath = RHCanonicalPath([NSString stringWithUTF8String:actual]);
  unsigned long long seconds = 0;
  unsigned long long microseconds = 0;
  return actualPath != nil && [actualPath isEqualToString:entry[@"binary_path"]] &&
      RHProcessStartTime(pid, &seconds, &microseconds) &&
      seconds == [entry[@"start_sec"] unsignedLongLongValue] &&
      microseconds == [entry[@"start_usec"] unsignedLongLongValue];
}

static BOOL RHWaitForCaptures(NSDictionary *tracks, NSTimeInterval seconds) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
  do {
    BOOL running = NO;
    for (NSDictionary *entry in tracks.allValues) running |= RHProcessMatches(entry);
    if (!running) return YES;
    usleep(50000);
  } while (deadline.timeIntervalSinceNow > 0);
  return NO;
}

NSString *RHNormalStopPath(NSString *controlRoot) {
  return [controlRoot stringByAppendingPathComponent:@"normal-stop.marker"];
}

BOOL RHMarkNormalStop(NSString *controlRoot, NSError **error) {
  return RHAtomicWriteJSON(@{@"schema_version": @1, @"normal_stop": @YES},
                           RHNormalStopPath(controlRoot), error);
}

@interface RHProcessRegistry ()
@property(nonatomic, readonly) NSString *allowedBinaryRoot;
@property(nonatomic, readonly) NSString *registryPath;
@end

@implementation RHProcessRegistry

- (instancetype)initWithControlRoot:(NSString *)controlRoot
                   allowedBinaryRoot:(NSString *)allowedBinaryRoot
                               error:(NSError **)error {
  self = [super init];
  if (self == nil) return nil;
  NSString *canonicalRoot = RHCanonicalPath(allowedBinaryRoot);
  BOOL isDirectory = NO;
  if (canonicalRoot == nil || ![NSFileManager.defaultManager
          fileExistsAtPath:canonicalRoot isDirectory:&isDirectory] || !isDirectory ||
      !RHEnsureOwnerDirectory(controlRoot, error)) {
    if (error != nil && *error == nil) {
      *error = RHRegistryError(1, @"allowed binary root is invalid");
    }
    return nil;
  }
  _allowedBinaryRoot = canonicalRoot;
  _registryPath = [controlRoot stringByAppendingPathComponent:@"capture-pids.json"];
  struct stat registryMetadata = {};
  if (lstat(_registryPath.fileSystemRepresentation, &registryMetadata) != 0) {
    if (errno != ENOENT || ![self writeTracks:@{} error:error]) return nil;
  }
  if ([self readTracks:error] == nil) return nil;
  return self;
}

- (NSDictionary<NSString *, NSDictionary *> *)readTracks:(NSError **)error {
  NSData *data = RHReadJournalFile(self.registryPath, error);
  if (data == nil) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![parsed isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *value = parsed;
  NSSet *expected = [NSSet setWithArray:@[@"schema_version", @"tracks"]];
  if (![[NSSet setWithArray:value.allKeys] isEqualToSet:expected] ||
      !RHIsJSONInteger(value[@"schema_version"], 1, 1) ||
      ![value[@"tracks"] isKindOfClass:NSDictionary.class]) {
    if (error != nil) *error = RHRegistryError(2, @"PID registry schema is invalid");
    return nil;
  }
  NSDictionary *tracks = value[@"tracks"];
  for (NSString *track in tracks) {
    NSDictionary *entry = tracks[track];
    NSSet *keys = [NSSet setWithArray:@[
      @"pid", @"binary_path", @"start_sec", @"start_usec"
    ]];
    if ((! [track isEqualToString:@"mic"] && ![track isEqualToString:@"system"]) ||
        ![entry isKindOfClass:NSDictionary.class] ||
        ![[NSSet setWithArray:entry.allKeys] isEqualToSet:keys] ||
        !RHIsJSONInteger(entry[@"pid"], 2, INT_MAX) ||
        !RHIsJSONInteger(entry[@"start_sec"], 1, RHJSONSafeIntegerMaximum) ||
        !RHIsJSONInteger(entry[@"start_usec"], 0, 999999) ||
        ![entry[@"binary_path"] isKindOfClass:NSString.class]) {
      if (error != nil) *error = RHRegistryError(2, @"PID registry entry is invalid");
      return nil;
    }
    NSString *canonical = RHCanonicalPath(entry[@"binary_path"]);
    if (canonical == nil || ![canonical isEqualToString:entry[@"binary_path"]] ||
        !RHPathIsWithin(canonical, self.allowedBinaryRoot)) {
      if (error != nil) *error = RHRegistryError(2, @"PID registry path is invalid");
      return nil;
    }
  }
  return tracks;
}

- (BOOL)writeTracks:(NSDictionary<NSString *, NSDictionary *> *)tracks error:(NSError **)error {
  return RHAtomicWriteJSON(@{@"schema_version": @1, @"tracks": tracks},
                           self.registryPath, error);
}

- (BOOL)setPID:(pid_t)pid
    binaryPath:(NSString *)binaryPath
      forTrack:(NSString *)track
         error:(NSError **)error {
  if (pid <= 1 || (![track isEqualToString:@"mic"] && ![track isEqualToString:@"system"])) {
    if (error != nil) *error = RHRegistryError(3, @"invalid capture process identity");
    return NO;
  }
  NSString *canonical = RHCanonicalPath(binaryPath);
  if (canonical == nil || !RHPathIsWithin(canonical, self.allowedBinaryRoot)) {
    if (error != nil) *error = RHRegistryError(3, @"capture binary is outside the app");
    return NO;
  }
  unsigned long long seconds = 0;
  unsigned long long microseconds = 0;
  if (!RHProcessStartTime(pid, &seconds, &microseconds)) {
    if (error != nil) *error = RHRegistryError(3, @"capture process identity is unavailable");
    return NO;
  }
  NSDictionary *stored = [self readTracks:error];
  if (stored == nil) return NO;
  NSMutableDictionary *tracks = [stored mutableCopy];
  tracks[track] = @{
    @"pid": @(pid),
    @"binary_path": canonical,
    @"start_sec": @(seconds),
    @"start_usec": @(microseconds),
  };
  return [self writeTracks:tracks error:error];
}

- (BOOL)clearTrack:(NSString *)track error:(NSError **)error {
  NSDictionary *stored = [self readTracks:error];
  if (stored == nil) return NO;
  NSMutableDictionary *tracks = [stored mutableCopy];
  [tracks removeObjectForKey:track];
  return [self writeTracks:tracks error:error];
}

- (NSUInteger)stopTrackedProcessesWithError:(NSError **)error {
  NSDictionary<NSString *, NSDictionary *> *tracks = [self readTracks:error];
  if (tracks == nil) return 0;
  NSUInteger signaled = 0;
  for (NSDictionary *entry in tracks.allValues) {
    pid_t pid = [entry[@"pid"] intValue];
    if (RHProcessMatches(entry) && kill(pid, SIGTERM) == 0) signaled += 1;
  }
  RHWaitForCaptures(tracks, 2.0);
  for (NSDictionary *entry in tracks.allValues) {
    pid_t pid = [entry[@"pid"] intValue];
    if (RHProcessMatches(entry)) kill(pid, SIGKILL);
  }
  if (!RHWaitForCaptures(tracks, 2.0)) {
    if (error != nil) *error = RHRegistryError(4, @"capture termination timed out");
    return 0;
  }
  if (![self writeTracks:@{} error:error]) return 0;
  return signaled;
}

@end

static BOOL RHControlFlag(NSString *controlRoot, NSString *filename, NSString *key) {
  NSData *data = RHReadJournalFile([controlRoot stringByAppendingPathComponent:filename], nil);
  if (data == nil) return NO;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class] || [value count] != 2 ||
      !RHIsJSONInteger(value[@"schema_version"], 1, 1)) return NO;
  id flag = value[key];
  return flag != nil && CFGetTypeID((__bridge CFTypeRef)flag) == CFBooleanGetTypeID() &&
      [flag boolValue];
}

static BOOL RHStopHelper(RHProcessIdentity identity) {
  if (!RHProcessIdentityIsAlive(identity)) return YES;
  kill(identity.processID, SIGTERM);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while (RHProcessIdentityIsAlive(identity) && deadline.timeIntervalSinceNow > 0) usleep(50000);
  if (RHProcessIdentityIsAlive(identity)) kill(identity.processID, SIGKILL);
  deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while (RHProcessIdentityIsAlive(identity) && deadline.timeIntervalSinceNow > 0) usleep(50000);
  return !RHProcessIdentityIsAlive(identity);
}

int RHRunWatchdog(RHProcessIdentity helperIdentity,
                  RHProcessIdentity hostIdentity,
                  NSString *controlRoot,
                  NSString *allowedBinaryRoot) {
  while (RHProcessIdentityIsAlive(helperIdentity) &&
         RHProcessIdentityIsAlive(hostIdentity)) {
    if (RHControlFlag(controlRoot, @"host-cancel.json", @"cancel")) break;
    if (RHControlFlag(controlRoot, @"normal-stop.marker", @"normal_stop")) return 0;
    usleep(100000);
  }
  if (!RHControlFlag(controlRoot, @"host-cancel.json", @"cancel") &&
      RHControlFlag(controlRoot, @"normal-stop.marker", @"normal_stop")) return 0;
  // Stop the producer before reading the registry so no new capture can escape cleanup.
  BOOL helperStopped = RHStopHelper(helperIdentity);
  NSError *error = nil;
  RHProcessRegistry *registry = [[RHProcessRegistry alloc]
      initWithControlRoot:controlRoot allowedBinaryRoot:allowedBinaryRoot error:&error];
  if (registry == nil) return 70;
  [registry stopTrackedProcessesWithError:&error];
  if (!helperStopped || error != nil) return 74;
  return RHAtomicWriteJSON(@{@"schema_version": @1, @"cancelled": @YES},
      [controlRoot stringByAppendingPathComponent:@"host-cancelled.json"], &error) ? 0 : 74;
}
