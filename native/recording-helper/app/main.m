#import <Foundation/Foundation.h>

#import "RHPermissions.h"
#import "RHProcessRegistry.h"
#import "RHRecordingSession.h"

#import <limits.h>
#import <errno.h>
#import <signal.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

static volatile sig_atomic_t gStopSignal = 0;

static void RHHandleStop(int signalNumber) {
  gStopSignal = signalNumber;
}

static NSString *RHCanonicalPath(NSString *path) {
  char resolved[PATH_MAX] = {0};
  if (realpath(path.fileSystemRepresentation, resolved) == NULL) return nil;
  return [NSString stringWithUTF8String:resolved];
}

static NSString *RHValidateSessionRoot(NSString *input, NSString *meetingID) {
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:meetingID];
  if (uuid == nil || ![uuid.UUIDString.lowercaseString isEqualToString:meetingID.lowercaseString]) {
    return nil;
  }
  if (!input.isAbsolutePath ||
      [input.lastPathComponent caseInsensitiveCompare:meetingID] != NSOrderedSame) return nil;
  NSString *canonical = RHCanonicalPath(input);
  if (canonical == nil || ![canonical isEqualToString:input]) return nil;
  struct stat root = {};
  if (lstat(canonical.fileSystemRepresentation, &root) != 0 || !S_ISDIR(root.st_mode) ||
      root.st_uid != geteuid() || (root.st_mode & 0077) != 0) return nil;
  return canonical;
}

static NSString *RHUnsignedArgument(unsigned long long value) {
  return [NSString stringWithFormat:@"%llu", value];
}

static NSTask *RHStartWatchdog(NSString *controlRoot,
                               NSString *binaryRoot,
                               RHProcessIdentity helperIdentity,
                               RHProcessIdentity hostIdentity,
                               NSError **error) {
  NSTask *watchdog = [[NSTask alloc] init];
  watchdog.executableURL = [NSURL fileURLWithPath:NSBundle.mainBundle.executablePath];
  watchdog.arguments = @[
    @"__watchdog",
    RHUnsignedArgument((unsigned long long)helperIdentity.processID),
    RHUnsignedArgument(helperIdentity.startSeconds),
    RHUnsignedArgument(helperIdentity.startMicroseconds),
    RHUnsignedArgument((unsigned long long)hostIdentity.processID),
    RHUnsignedArgument(hostIdentity.startSeconds),
    RHUnsignedArgument(hostIdentity.startMicroseconds),
    controlRoot,
    binaryRoot,
  ];
  watchdog.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  watchdog.standardError = NSFileHandle.fileHandleWithNullDevice;
  return [watchdog launchAndReturnError:error] ? watchdog : nil;
}

static int RHRunProductSession(NSString *root,
                               NSString *meetingID,
                               RHProcessIdentity hostIdentity) {
  NSString *binaryRoot = [NSBundle.mainBundle.bundlePath
      stringByAppendingPathComponent:@"Contents/Helpers"];
  NSString *canonicalBinaryRoot = RHCanonicalPath(binaryRoot);
  if (canonicalBinaryRoot == nil) return 70;
  NSError *error = nil;
  RHRecordingSession *session = [[RHRecordingSession alloc]
      initWithSessionRoot:root meetingID:meetingID binaryRoot:canonicalBinaryRoot
      microphoneAuthorizer:^RHMicrophoneAuthorization {
        return RHRequestMicrophoneAuthorization(120.0);
      } error:&error];
  if (session == nil) return 70;
  NSString *controlRoot = [root stringByAppendingPathComponent:@"control"];
  RHProcessIdentity helperIdentity = {};
  if (!RHReadProcessIdentity(NSProcessInfo.processInfo.processIdentifier, &helperIdentity)) return 70;
  NSTask *watchdog = RHStartWatchdog(controlRoot, canonicalBinaryRoot,
                                     helperIdentity, hostIdentity, &error);
  if (watchdog == nil) return 70;
  BOOL completed = [session runUntil:^BOOL { return gStopSignal != 0; }];
  [watchdog waitUntilExit];
  return completed ? 0 : 65;
}

static BOOL RHParseUnsigned(const char *raw,
                            unsigned long long minimum,
                            unsigned long long maximum,
                            unsigned long long *value) {
  if (raw == NULL || raw[0] == '\0') return NO;
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || parsed < minimum || parsed > maximum) return NO;
  *value = parsed;
  return YES;
}

static BOOL RHParseIdentity(const char *const argv[],
                            int offset,
                            RHProcessIdentity *identity) {
  unsigned long long processID = 0;
  return RHParseUnsigned(argv[offset], 2, INT_MAX, &processID) &&
      RHParseUnsigned(argv[offset + 1], 1, ULLONG_MAX, &identity->startSeconds) &&
      RHParseUnsigned(argv[offset + 2], 0, 999999, &identity->startMicroseconds) &&
      (identity->processID = (pid_t)processID) > 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 10 && strcmp(argv[1], "__watchdog") == 0) {
      RHProcessIdentity helperIdentity = {};
      RHProcessIdentity hostIdentity = {};
      if (!RHParseIdentity(argv, 2, &helperIdentity) ||
          !RHParseIdentity(argv, 5, &hostIdentity)) return 64;
      return RHRunWatchdog(helperIdentity, hostIdentity,
                           [NSString stringWithUTF8String:argv[8]],
                           [NSString stringWithUTF8String:argv[9]]);
    }
    if (argc != 4) return 64;
    NSString *meetingID = [NSString stringWithUTF8String:argv[2]];
    NSString *root = RHValidateSessionRoot([NSString stringWithUTF8String:argv[1]], meetingID);
    unsigned long long hostProcessID = 0;
    RHProcessIdentity hostIdentity = {};
    if (root == nil || !RHParseUnsigned(argv[3], 2, INT_MAX, &hostProcessID) ||
        !RHReadProcessIdentity((pid_t)hostProcessID, &hostIdentity)) return 64;
    signal(SIGTERM, RHHandleStop);
    signal(SIGINT, RHHandleStop);
    return RHRunProductSession(root, meetingID, hostIdentity);
  }
}
