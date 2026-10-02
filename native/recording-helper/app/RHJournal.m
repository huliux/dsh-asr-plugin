#import "RHJournal.h"

#import <CoreFoundation/CoreFoundation.h>
#import <errno.h>
#import <fcntl.h>
#import <math.h>
#import <sys/stat.h>
#import <unistd.h>

const NSUInteger RHJournalMaximumBytes = 4 * 1024;
const long long RHJSONSafeIntegerMaximum = 9007199254740991LL;

static NSString *const RHJournalErrorDomain = @"com.bitbook.dsh-asr.recording-helper.journal";

@implementation RHCommand

- (instancetype)initWithCommandID:(NSInteger)commandID action:(NSString *)action {
  self = [super init];
  if (self != nil) {
    _commandID = commandID;
    _action = [action copy];
  }
  return self;
}

@end

static void RHSetCode(NSString **errorCode, NSString *code) {
  if (errorCode != nil) *errorCode = code;
}

static BOOL RHHasExactKeys(NSDictionary *value, NSSet<NSString *> *expected) {
  NSSet *actual = [NSSet setWithArray:value.allKeys];
  return [actual isEqualToSet:expected];
}

BOOL RHIsJSONInteger(id value, long long minimum, long long maximum) {
  if (![value isKindOfClass:NSNumber.class] || minimum > maximum) return NO;
  NSNumber *number = value;
  if (CFGetTypeID((__bridge CFTypeRef)number) == CFBooleanGetTypeID()) return NO;
  double numericValue = number.doubleValue;
  long long integer = number.longLongValue;
  return isfinite(numericValue) && numericValue == (double)integer &&
         integer >= minimum && integer <= maximum;
}

RHCommandDisposition RHParseCommandData(
    NSData *data,
    NSInteger expectedCommandID,
    RHCommand **command,
    NSString **errorCode) {
  if (command != nil) *command = nil;
  if (data.length == 0 || data.length > RHJournalMaximumBytes ||
      [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] == nil) {
    RHSetCode(errorCode, @"COMMAND_ENCODING_INVALID");
    return RHCommandDispositionInvalid;
  }
  NSError *parseError = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
  if (![parsed isKindOfClass:NSDictionary.class] || parseError != nil) {
    RHSetCode(errorCode, @"COMMAND_JSON_INVALID");
    return RHCommandDispositionInvalid;
  }
  NSDictionary *value = parsed;
  NSSet *keys = [NSSet setWithArray:@[@"schema_version", @"command_id", @"action"]];
  if (!RHHasExactKeys(value, keys) ||
      !RHIsJSONInteger(value[@"schema_version"], 1, 1) ||
      ![value[@"action"] isKindOfClass:NSString.class]) {
    RHSetCode(errorCode, @"COMMAND_SCHEMA_INVALID");
    return RHCommandDispositionInvalid;
  }
  NSNumber *identifier = value[@"command_id"];
  NSString *action = value[@"action"];
  NSSet *actions = [NSSet setWithArray:@[
    @"mic_on", @"mic_off", @"system_on", @"system_off", @"stop"
  ]];
  if (!RHIsJSONInteger(identifier, 1, RHJSONSafeIntegerMaximum) ||
      ![actions containsObject:action]) {
    RHSetCode(errorCode, @"COMMAND_SCHEMA_INVALID");
    return RHCommandDispositionInvalid;
  }
  NSInteger commandID = identifier.integerValue;
  if (commandID < expectedCommandID) {
    RHSetCode(errorCode, @"COMMAND_DUPLICATE");
    return RHCommandDispositionDuplicate;
  }
  if (commandID > expectedCommandID) {
    RHSetCode(errorCode, @"COMMAND_SEQUENCE_INVALID");
    return RHCommandDispositionSequenceGap;
  }
  if (command != nil) {
    *command = [[RHCommand alloc] initWithCommandID:commandID action:action];
  }
  return RHCommandDispositionApply;
}

static NSError *RHError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:RHJournalErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

BOOL RHEnsureOwnerDirectory(NSString *path, NSError **error) {
  NSFileManager *manager = NSFileManager.defaultManager;
  struct stat metadata = {};
  if (lstat(path.fileSystemRepresentation, &metadata) != 0) {
    if (errno != ENOENT || ![manager createDirectoryAtPath:path
                             withIntermediateDirectories:YES
                                              attributes:@{NSFilePosixPermissions: @0700}
                                                   error:error] ||
        lstat(path.fileSystemRepresentation, &metadata) != 0) {
      if (error != nil && *error == nil) {
        *error = RHError(errno, @"cannot create journal directory");
      }
      return NO;
    }
  }
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != geteuid()) {
    if (error != nil) *error = RHError(1, @"journal path is not an owner directory");
    return NO;
  }
  if (chmod(path.fileSystemRepresentation, 0700) != 0) {
    if (error != nil) *error = RHError(errno, @"cannot secure journal directory");
    return NO;
  }
  return YES;
}

static BOOL RHWriteAll(int descriptor, const uint8_t *bytes, NSUInteger length) {
  NSUInteger offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return NO;
    offset += (NSUInteger)written;
  }
  return YES;
}

static BOOL RHReadAll(int descriptor, uint8_t *bytes, NSUInteger length) {
  NSUInteger offset = 0;
  while (offset < length) {
    ssize_t count = read(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return NO;
    offset += (NSUInteger)count;
  }
  return YES;
}

NSData *RHReadJournalFile(NSString *path, NSError **error) {
  int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  struct stat before = {};
  if (descriptor < 0 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_uid != geteuid() || (before.st_mode & 0077) != 0 ||
      before.st_size <= 0 || before.st_size > RHJournalMaximumBytes) {
    if (descriptor >= 0) close(descriptor);
    if (error != nil) *error = RHError(errno, @"journal file is invalid");
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
  BOOL complete = RHReadAll(descriptor, data.mutableBytes, data.length);
  struct stat after = {};
  BOOL stable = complete && fstat(descriptor, &after) == 0 &&
      before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
      before.st_size == after.st_size &&
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
  int closeResult = close(descriptor);
  if (!stable || closeResult != 0) {
    if (error != nil) *error = RHError(errno, @"journal file changed while being read");
    return nil;
  }
  return data;
}

static void RHSyncParentDirectory(NSString *path) {
  NSString *directory = path.stringByDeletingLastPathComponent;
  int descriptor = open(directory.fileSystemRepresentation, O_RDONLY | O_DIRECTORY);
  if (descriptor >= 0) {
    fsync(descriptor);
    close(descriptor);
  }
}

BOOL RHAtomicWriteJSON(NSDictionary<NSString *, id> *payload,
                       NSString *path,
                       NSError **error) {
  if (![NSJSONSerialization isValidJSONObject:payload]) {
    if (error != nil) *error = RHError(2, @"event payload is not JSON");
    return NO;
  }
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:error];
  if (body == nil) return NO;
  NSMutableData *data = [body mutableCopy];
  [data appendBytes:"\n" length:1];
  if (data.length > RHJournalMaximumBytes) {
    if (error != nil) *error = RHError(3, @"journal record exceeds 4 KiB");
    return NO;
  }
  NSString *temporary = [path.stringByDeletingLastPathComponent
      stringByAppendingPathComponent:[NSString stringWithFormat:@".%@.%@.tmp",
          path.lastPathComponent, NSUUID.UUID.UUIDString]];
  int descriptor = open(temporary.fileSystemRepresentation,
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    if (error != nil) *error = RHError(errno, @"cannot create journal temporary file");
    return NO;
  }
  BOOL ok = RHWriteAll(descriptor, data.bytes, data.length) && fsync(descriptor) == 0;
  int closeResult = close(descriptor);
  if (!ok || closeResult != 0 || rename(temporary.fileSystemRepresentation,
                                        path.fileSystemRepresentation) != 0) {
    int saved = errno;
    unlink(temporary.fileSystemRepresentation);
    if (error != nil) *error = RHError(saved, @"cannot publish journal record");
    return NO;
  }
  chmod(path.fileSystemRepresentation, 0600);
  RHSyncParentDirectory(path);
  return YES;
}

@interface RHEventJournal ()
@property(nonatomic, readwrite) NSInteger nextSequence;
@property(nonatomic, readonly) NSString *eventsRoot;
@end

@implementation RHEventJournal

- (instancetype)initWithControlRoot:(NSString *)controlRoot error:(NSError **)error {
  self = [super init];
  if (self == nil) return nil;
  _eventsRoot = [controlRoot stringByAppendingPathComponent:@"events"];
  if (!RHEnsureOwnerDirectory(_eventsRoot, error)) return nil;
  NSArray<NSString *> *entries = [NSFileManager.defaultManager
      contentsOfDirectoryAtPath:_eventsRoot error:error];
  if (entries == nil) return nil;
  NSMutableSet<NSNumber *> *sequences = [NSMutableSet set];
  for (NSString *entry in entries) {
    if (![entry.pathExtension isEqualToString:@"json"]) continue;
    NSString *stem = entry.stringByDeletingPathExtension;
    NSScanner *scanner = [NSScanner scannerWithString:stem];
    long long value = 0;
    if (![scanner scanLongLong:&value] || !scanner.isAtEnd || value <= 0) {
      if (error != nil) *error = RHError(4, @"invalid event filename");
      return nil;
    }
    [sequences addObject:@(value)];
  }
  NSInteger count = sequences.count;
  for (NSInteger sequence = 1; sequence <= count; sequence += 1) {
    if (![sequences containsObject:@(sequence)]) {
      if (error != nil) *error = RHError(5, @"event sequence contains a gap");
      return nil;
    }
  }
  _nextSequence = count + 1;
  return self;
}

- (BOOL)appendType:(NSString *)type
            fields:(NSDictionary<NSString *, id> *)fields
             error:(NSError **)error {
  if (type.length == 0 || fields[@"schema_version"] != nil ||
      fields[@"event_seq"] != nil || fields[@"type"] != nil) {
    if (error != nil) *error = RHError(6, @"invalid event fields");
    return NO;
  }
  NSMutableDictionary *payload = [@{
    @"schema_version": @1,
    @"event_seq": @(self.nextSequence),
    @"type": type,
  } mutableCopy];
  [payload addEntriesFromDictionary:fields];
  NSString *path = [self.eventsRoot stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%ld.json", (long)self.nextSequence]];
  if (!RHAtomicWriteJSON(payload, path, error)) return NO;
  self.nextSequence += 1;
  return YES;
}

@end
