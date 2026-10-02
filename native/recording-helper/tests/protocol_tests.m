#import <Foundation/Foundation.h>
#import <sys/stat.h>

#import "RHJournal.h"

static void Require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static NSData *JSON(id value) {
  return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
}

static void TestCommandContract(void) {
  RHCommand *command = nil;
  NSString *code = nil;
  NSData *valid = JSON(@{@"schema_version": @1, @"command_id": @1, @"action": @"mic_off"});
  Require(RHParseCommandData(valid, 1, &command, &code) == RHCommandDispositionApply,
          @"valid command must apply");
  Require(command.commandID == 1 && [command.action isEqualToString:@"mic_off"],
          @"valid command fields must be preserved");
  Require(RHParseCommandData(valid, 2, nil, &code) == RHCommandDispositionDuplicate,
          @"old command id must be duplicate");

  NSData *gap = JSON(@{@"schema_version": @1, @"command_id": @3, @"action": @"stop"});
  Require(RHParseCommandData(gap, 2, nil, &code) == RHCommandDispositionSequenceGap,
          @"jumped command id must fail closed");
  Require([code isEqualToString:@"COMMAND_SEQUENCE_INVALID"],
          @"jumped command must have stable error code");

  NSData *unknown = JSON(@{
    @"schema_version": @1, @"command_id": @2, @"action": @"stop", @"extra": @1
  });
  Require(RHParseCommandData(unknown, 2, nil, &code) == RHCommandDispositionInvalid,
          @"unknown field must fail closed");
  NSData *unknownAction = JSON(@{
    @"schema_version": @1, @"command_id": @2, @"action": @"restart"
  });
  Require(RHParseCommandData(unknownAction, 2, nil, &code) == RHCommandDispositionInvalid,
          @"unknown action must fail closed");
  for (NSDictionary *invalidNumber in @[
    @{@"schema_version": @YES, @"command_id": @2, @"action": @"stop"},
    @{@"schema_version": @1, @"command_id": @YES, @"action": @"stop"},
    @{@"schema_version": @1, @"command_id": @2.5, @"action": @"stop"},
  ]) {
    Require(RHParseCommandData(JSON(invalidNumber), 2, nil, &code) ==
                RHCommandDispositionInvalid,
            @"booleans and fractional command numbers must fail closed");
  }
  Require(RHParseCommandData([@"{\"schema_version\":" dataUsingEncoding:NSUTF8StringEncoding],
                             2, nil, &code) == RHCommandDispositionInvalid,
          @"partial final JSON must fail closed");
}

static void TestAtomicEventJournal(void) {
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-protocol-%@", NSUUID.UUID.UUIDString]];
  NSError *error = nil;
  RHEventJournal *journal = [[RHEventJournal alloc] initWithControlRoot:root error:&error];
  Require(journal != nil, error.localizedDescription ?: @"journal must initialize");
  Require([journal appendType:@"helper_ready" fields:@{} error:&error],
          error.localizedDescription ?: @"first event must publish");
  Require([journal appendType:@"helper_stopped" fields:@{} error:&error],
          error.localizedDescription ?: @"second event must publish");

  NSString *events = [root stringByAppendingPathComponent:@"events"];
  NSArray<NSString *> *names = [[NSFileManager defaultManager]
      contentsOfDirectoryAtPath:events error:&error];
  Require([[NSSet setWithArray:names]
              isEqualToSet:[NSSet setWithArray:@[@"1.json", @"2.json"]]],
          @"journal must expose only closed contiguous events");
  struct stat directoryStat = {};
  struct stat eventStat = {};
  Require(stat(events.fileSystemRepresentation, &directoryStat) == 0 &&
              (directoryStat.st_mode & 0777) == 0700,
          @"event directory must be owner-only");
  NSString *eventPath = [events stringByAppendingPathComponent:@"1.json"];
  Require(stat(eventPath.fileSystemRepresentation, &eventStat) == 0 &&
              (eventStat.st_mode & 0777) == 0600,
          @"event file must be owner-only");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestOwnerDirectoryRejectsSymlink(void) {
  NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-directory-%@", NSUUID.UUID.UUIDString]];
  NSString *target = [base stringByAppendingPathComponent:@"target"];
  NSString *link = [base stringByAppendingPathComponent:@"control"];
  NSError *error = nil;
  Require([NSFileManager.defaultManager createDirectoryAtPath:target
                                  withIntermediateDirectories:YES
                                                   attributes:@{NSFilePosixPermissions: @0700}
                                                        error:&error],
          @"symlink target fixture must initialize");
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:link
                                             withDestinationPath:target error:&error],
          @"symlink fixture must initialize");
  Require(!RHEnsureOwnerDirectory(link, &error),
          @"owner directory validation must reject a symbolic link");
  [NSFileManager.defaultManager removeItemAtPath:base error:nil];
}

int main(void) {
  @autoreleasepool {
    TestCommandContract();
    TestAtomicEventJournal();
    TestOwnerDirectoryRejectsSymlink();
    puts("{\"protocol_tests\":\"passed\"}");
    return 0;
  }
}
