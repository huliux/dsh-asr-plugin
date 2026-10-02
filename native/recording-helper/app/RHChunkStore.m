#import "RHChunkStore.h"

#import "RHJournal.h"

#import <CoreFoundation/CoreFoundation.h>
#import <errno.h>
#import <fcntl.h>
#import <math.h>
#import <sys/stat.h>
#import <unistd.h>

NSString *const RHChunkStoreErrorDomain = @"com.bitbook.dsh-asr.recording-helper.chunks";

static const NSUInteger RHMaximumChunkBytes = 2 * 1024 * 1024;
static const long long RHMicrosPerSecond = 1000000LL;
static const long long RHSampleRate = 16000LL;
static const long long RHFrameToleranceUs = 63LL;

@implementation RHChunkMetadata

- (instancetype)initWithStartUs:(long long)startUs
                           endUs:(long long)endUs
                      frameCount:(unsigned long long)frameCount
                       hasSignal:(BOOL)hasSignal
                            path:(NSString *)path {
  self = [super init];
  if (self != nil) {
    _startUs = startUs;
    _endUs = endUs;
    _frameCount = frameCount;
    _hasSignal = hasSignal;
    _path = [path copy];
  }
  return self;
}

@end

static NSError *RHChunkError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:RHChunkStoreErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static uint16_t RHRead16(const uint8_t *bytes) {
  uint16_t value = 0;
  memcpy(&value, bytes, sizeof(value));
  return CFSwapInt16LittleToHost(value);
}

static uint32_t RHRead32(const uint8_t *bytes) {
  uint32_t value = 0;
  memcpy(&value, bytes, sizeof(value));
  return CFSwapInt32LittleToHost(value);
}

static NSData *RHReadRegularChunk(NSString *path, NSError **error) {
  int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  struct stat before = {};
  if (descriptor < 0 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_uid != geteuid() || before.st_size < 44 ||
      before.st_size > RHMaximumChunkBytes) {
    if (descriptor >= 0) close(descriptor);
    if (error != nil) *error = RHChunkError(3, @"WAV size is outside the chunk bound");
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
  NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t count = read(descriptor, (uint8_t *)data.mutableBytes + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    offset += (NSUInteger)count;
  }
  struct stat after = {};
  BOOL stable = offset == data.length && fstat(descriptor, &after) == 0 &&
      before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
      before.st_size == after.st_size;
  close(descriptor);
  if (!stable) {
    if (error != nil) *error = RHChunkError(3, @"WAV changed while being inspected");
    return nil;
  }
  return data;
}

static BOOL RHInspectWave(NSString *path, unsigned long long *frames, BOOL *hasSignal,
                          NSError **error) {
  NSData *data = RHReadRegularChunk(path, error);
  if (data == nil) return NO;
  unsigned long long size = data.length;
  const uint8_t *bytes = data.bytes;
  if (memcmp(bytes, "RIFF", 4) != 0 || memcmp(bytes + 8, "WAVE", 4) != 0 ||
      (unsigned long long)RHRead32(bytes + 4) + 8 > size) {
    if (error != nil) *error = RHChunkError(3, @"WAV RIFF header is invalid");
    return NO;
  }
  BOOL foundFormat = NO;
  BOOL foundData = NO;
  uint16_t blockAlign = 0;
  unsigned long long frameCount = 0;
  BOOL nonzero = NO;
  NSUInteger offset = 12;
  while (offset + 8 <= data.length) {
    const uint8_t *header = bytes + offset;
    uint32_t chunkBytes = RHRead32(header + 4);
    NSUInteger payload = offset + 8;
    if ((unsigned long long)payload + chunkBytes > data.length) {
      if (error != nil) *error = RHChunkError(3, @"WAV chunk is truncated");
      return NO;
    }
    if (memcmp(header, "fmt ", 4) == 0) {
      if (chunkBytes < 16 || RHRead16(bytes + payload) != 1 ||
          RHRead16(bytes + payload + 2) != 1 || RHRead32(bytes + payload + 4) != 16000 ||
          RHRead16(bytes + payload + 12) != 2 || RHRead16(bytes + payload + 14) != 16) {
        if (error != nil) *error = RHChunkError(3, @"WAV format must be PCM16 mono 16 kHz");
        return NO;
      }
      blockAlign = 2;
      foundFormat = YES;
    } else if (memcmp(header, "data", 4) == 0) {
      if (!foundFormat || blockAlign == 0 || chunkBytes == 0 || chunkBytes % blockAlign != 0) {
        if (error != nil) *error = RHChunkError(3, @"WAV data chunk is invalid");
        return NO;
      }
      frameCount = chunkBytes / blockAlign;
      for (NSUInteger index = 0; !nonzero && index < chunkBytes; index++) {
        nonzero = bytes[payload + index] != 0;
      }
      foundData = YES;
    }
    offset = payload + chunkBytes + (chunkBytes % 2);
  }
  if (!foundFormat || !foundData || frameCount == 0) {
    if (error != nil) *error = RHChunkError(3, @"WAV is missing format or audio frames");
    return NO;
  }
  *frames = frameCount;
  if (hasSignal != NULL) *hasSignal = nonzero;
  return YES;
}

static NSRegularExpression *RHIncomingPattern(NSString *track) {
  NSString *escaped = [NSRegularExpression escapedPatternForString:track];
  NSString *pattern = [NSString stringWithFormat:
      @"^([0-9]+(?:\\.[0-9]+)?)-([0-9]+(?:\\.[0-9]+)?)-%@\\.wav$", escaped];
  return [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
}

static BOOL RHParseIncomingName(NSString *name,
                                NSRegularExpression *pattern,
                                long long *startUs,
                                long long *namedEndUs) {
  NSTextCheckingResult *match = [pattern firstMatchInString:name options:0
                                                      range:NSMakeRange(0, name.length)];
  if (match == nil) return NO;
  double start = [[name substringWithRange:[match rangeAtIndex:1]] doubleValue];
  double end = [[name substringWithRange:[match rangeAtIndex:2]] doubleValue];
  if (!isfinite(start) || !isfinite(end) || start <= 0 || end <= start) return NO;
  *startUs = llround(start * RHMicrosPerSecond);
  *namedEndUs = llround(end * RHMicrosPerSecond);
  return *startUs > 0 && *namedEndUs > *startUs;
}

static BOOL RHParseClosedName(NSString *name, long long *startUs, long long *endUs) {
  NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:@"^([0-9]+)-([0-9]+)\\.wav$" options:0 error:nil];
  NSTextCheckingResult *match = [pattern firstMatchInString:name options:0
                                                      range:NSMakeRange(0, name.length)];
  if (match == nil) return NO;
  *startUs = [[name substringWithRange:[match rangeAtIndex:1]] longLongValue];
  *endUs = [[name substringWithRange:[match rangeAtIndex:2]] longLongValue];
  return *startUs > 0 && *endUs > *startUs;
}

static void RHSync(NSString *path, BOOL directory) {
  int flags = O_RDONLY | (directory ? O_DIRECTORY : 0);
  int descriptor = open(path.fileSystemRepresentation, flags);
  if (descriptor >= 0) {
    fsync(descriptor);
    close(descriptor);
  }
}

@interface RHChunkStore ()
@property(nonatomic) long long lastEndUs;
@property(nonatomic, readonly) NSRegularExpression *incomingPattern;
@end

@implementation RHChunkStore

- (instancetype)initWithRecordingRoot:(NSString *)recordingRoot
                                  track:(NSString *)track
                                  error:(NSError **)error {
  if (![track isEqualToString:@"mic"] && ![track isEqualToString:@"system"]) {
    if (error != nil) *error = RHChunkError(1, @"unknown recording track");
    return nil;
  }
  self = [super init];
  if (self == nil) return nil;
  _track = [track copy];
  NSString *trackRoot = [recordingRoot stringByAppendingPathComponent:track];
  _incomingRoot = [trackRoot stringByAppendingPathComponent:@"incoming"];
  _chunksRoot = [trackRoot stringByAppendingPathComponent:@"chunks"];
  _incomingPattern = RHIncomingPattern(track);
  if (!RHEnsureOwnerDirectory(trackRoot, error) ||
      !RHEnsureOwnerDirectory(_incomingRoot, error) ||
      !RHEnsureOwnerDirectory(_chunksRoot, error) || ![self loadExistingChunks:error]) {
    return nil;
  }
  return self;
}

- (BOOL)loadExistingChunks:(NSError **)error {
  NSArray<NSString *> *names = [NSFileManager.defaultManager
      contentsOfDirectoryAtPath:self.chunksRoot error:error];
  if (names == nil) return NO;
  NSArray<NSString *> *sorted = [names sortedArrayUsingSelector:@selector(compare:)];
  long long previousEnd = 0;
  for (NSString *name in sorted) {
    long long startUs = 0;
    long long endUs = 0;
    NSString *path = [self.chunksRoot stringByAppendingPathComponent:name];
    unsigned long long frames = 0;
    if (!RHParseClosedName(name, &startUs, &endUs) || !RHInspectWave(path, &frames, NULL, error)) {
      if (error != nil && *error == nil) *error = RHChunkError(3, @"existing chunk is invalid");
      return NO;
    }
    long long expectedEnd = startUs + llround((double)frames * RHMicrosPerSecond / RHSampleRate);
    if (llabs(expectedEnd - endUs) > RHFrameToleranceUs || startUs < previousEnd) {
      if (error != nil) *error = RHChunkError(4, @"existing chunk timeline is invalid");
      return NO;
    }
    previousEnd = endUs;
  }
  self.lastEndUs = previousEnd;
  return YES;
}

- (NSArray<NSDictionary *> *)incomingCandidatesWithError:(NSError **)error {
  NSArray<NSString *> *names = [NSFileManager.defaultManager
      contentsOfDirectoryAtPath:self.incomingRoot error:error];
  if (names == nil) return nil;
  NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
  for (NSString *name in names) {
    if ([name hasPrefix:@"temp_chunk_"]) continue;
    long long startUs = 0;
    long long namedEndUs = 0;
    if (!RHParseIncomingName(name, self.incomingPattern, &startUs, &namedEndUs)) {
      if ([name.pathExtension isEqualToString:@"wav"]) {
        if (error != nil) *error = RHChunkError(3, @"closed chunk filename is invalid");
        return nil;
      }
      continue;
    }
    [candidates addObject:@{@"name": name, @"start": @(startUs), @"end": @(namedEndUs)}];
  }
  [candidates sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"start"] compare:right[@"start"]];
  }];
  return candidates;
}

- (NSArray<NSDictionary *> *)promotionPlan:(NSArray<NSDictionary *> *)candidates
                                      error:(NSError **)error {
  NSMutableArray<NSDictionary *> *plan = [NSMutableArray array];
  long long previousEndUs = self.lastEndUs;
  for (NSDictionary *candidate in candidates) {
    NSString *name = candidate[@"name"];
    long long startUs = [candidate[@"start"] longLongValue];
    long long namedEndUs = [candidate[@"end"] longLongValue];
    NSString *source = [self.incomingRoot stringByAppendingPathComponent:name];
    unsigned long long frames = 0;
    BOOL hasSignal = NO;
    if (!RHInspectWave(source, &frames, &hasSignal, error)) return nil;
    if (startUs < previousEndUs) {
      long long overlapUs = previousEndUs - startUs;
      if (overlapUs > RHFrameToleranceUs) {
        if (error != nil) *error = RHChunkError(4, @"same-track chunks overlap");
        return nil;
      }
      startUs = previousEndUs;
    }
    long long endUs = startUs + llround((double)frames * RHMicrosPerSecond / RHSampleRate);
    if (llabs(namedEndUs - endUs) > RHFrameToleranceUs) {
      if (error != nil) *error = RHChunkError(3, @"chunk filename and frame count disagree");
      return nil;
    }
    NSString *closedName = [NSString stringWithFormat:@"%lld-%lld.wav", startUs, endUs];
    NSString *destination = [self.chunksRoot stringByAppendingPathComponent:closedName];
    if ([NSFileManager.defaultManager fileExistsAtPath:destination]) {
      if (error != nil) *error = RHChunkError(2, @"closed chunk target already exists");
      return nil;
    }
    [plan addObject:@{
      @"source": source,
      @"destination": destination,
      @"metadata": [[RHChunkMetadata alloc] initWithStartUs:startUs
                                                       endUs:endUs
                                                  frameCount:frames
                                                   hasSignal:hasSignal
                                                        path:destination],
    }];
    previousEndUs = endUs;
  }
  return plan;
}

- (NSArray<RHChunkMetadata *> *)publishPlan:(NSArray<NSDictionary *> *)plan
                                       error:(NSError **)error {
  NSMutableArray<RHChunkMetadata *> *promoted = [NSMutableArray array];
  for (NSDictionary *item in plan) {
    NSString *source = item[@"source"];
    NSString *destination = item[@"destination"];
    RHChunkMetadata *metadata = item[@"metadata"];
    RHSync(source, NO);
    if (rename(source.fileSystemRepresentation, destination.fileSystemRepresentation) != 0) {
      if (error != nil) *error = RHChunkError(2, @"cannot publish closed chunk");
      return nil;
    }
    chmod(destination.fileSystemRepresentation, 0600);
    RHSync(self.incomingRoot, YES);
    RHSync(self.chunksRoot, YES);
    self.lastEndUs = metadata.endUs;
    [promoted addObject:metadata];
  }
  return promoted;
}

- (NSArray<RHChunkMetadata *> *)promoteClosedChunksWithError:(NSError **)error {
  NSArray<NSDictionary *> *candidates = [self incomingCandidatesWithError:error];
  if (candidates == nil) return nil;
  NSArray<NSDictionary *> *plan = [self promotionPlan:candidates error:error];
  return plan == nil ? nil : [self publishPlan:plan error:error];
}

@end
