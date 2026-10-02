#import <Foundation/Foundation.h>

#import "RHChunkStore.h"

static void Require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static void Put16(NSMutableData *data, uint16_t value) {
  uint16_t little = CFSwapInt16HostToLittle(value);
  [data appendBytes:&little length:sizeof(little)];
}

static void Put32(NSMutableData *data, uint32_t value) {
  uint32_t little = CFSwapInt32HostToLittle(value);
  [data appendBytes:&little length:sizeof(little)];
}

static NSData *Wave(NSUInteger frames) {
  uint32_t dataBytes = (uint32_t)(frames * 2);
  NSMutableData *data = [NSMutableData data];
  [data appendBytes:"RIFF" length:4];
  Put32(data, 36 + dataBytes);
  [data appendBytes:"WAVEfmt " length:8];
  Put32(data, 16);
  Put16(data, 1);
  Put16(data, 1);
  Put32(data, 16000);
  Put32(data, 32000);
  Put16(data, 2);
  Put16(data, 16);
  [data appendBytes:"data" length:4];
  Put32(data, dataBytes);
  [data increaseLengthBy:dataBytes];
  return data;
}

static NSString *TemporaryRoot(void) {
  return [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"recording-helper-chunks-%@", NSUUID.UUID.UUIDString]];
}

static void Write(NSData *data, NSString *path) {
  Require([data writeToFile:path atomically:NO], @"fixture write failed");
}

static void TestPromotionAndTail(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"mic"
                                                             error:&error];
  Require(store != nil, error.localizedDescription ?: @"store must initialize");
  NSString *incoming = [root stringByAppendingPathComponent:@"mic/incoming"];
  Write(Wave(160), [incoming stringByAppendingPathComponent:
      @"1800000000.0000000-1800000000.0100000-mic.wav"]);
  Write(Wave(80), [incoming stringByAppendingPathComponent:
      @"1800000000.0100000-1800000000.0150000-mic.wav"]);
  Write(Wave(160), [incoming stringByAppendingPathComponent:@"temp_chunk_1.wav"]);

  NSArray<RHChunkMetadata *> *chunks = [store promoteClosedChunksWithError:&error];
  Require(chunks.count == 2, error.localizedDescription ?: @"closed tail must be promoted");
  Require(chunks[0].frameCount == 160 && chunks[0].startUs == 1800000000000000LL &&
              chunks[0].endUs == 1800000000010000LL,
          @"first chunk frame/time must be conserved");
  Require(chunks[1].frameCount == 80 && chunks[1].endUs == 1800000000015000LL,
          @"short tail must be preserved");
  NSString *closed = [root stringByAppendingPathComponent:@"mic/chunks"];
  NSArray *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:closed error:&error];
  Require([names containsObject:@"1800000000000000-1800000000010000.wav"] &&
              [names containsObject:@"1800000000010000-1800000000015000.wav"],
          @"closed chunks must use integer microsecond names");
  Require([NSFileManager.defaultManager fileExistsAtPath:
      [incoming stringByAppendingPathComponent:@"temp_chunk_1.wav"]],
          @"in-progress temporary file must remain invisible");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestOverlapAndTruncation(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"system"
                                                             error:&error];
  Require(store != nil, error.localizedDescription ?: @"store must initialize");
  NSString *incoming = [root stringByAppendingPathComponent:@"system/incoming"];
  Write(Wave(160), [incoming stringByAppendingPathComponent:
      @"1800000000.0000000-1800000000.0100000-system.wav"]);
  Require([store promoteClosedChunksWithError:&error].count == 1,
          error.localizedDescription ?: @"first chunk must promote");
  Write(Wave(160), [incoming stringByAppendingPathComponent:
      @"1800000000.0050000-1800000000.0150000-system.wav"]);
  Require([store promoteClosedChunksWithError:&error] == nil &&
              [error.domain isEqualToString:RHChunkStoreErrorDomain] && error.code == 4,
          @"same-track overlap must fail closed");

  NSString *otherRoot = TemporaryRoot();
  RHChunkStore *other = [[RHChunkStore alloc] initWithRecordingRoot:otherRoot
                                                             track:@"mic"
                                                             error:&error];
  NSString *otherIncoming = [otherRoot stringByAppendingPathComponent:@"mic/incoming"];
  Write([@"RIFF" dataUsingEncoding:NSUTF8StringEncoding],
        [otherIncoming stringByAppendingPathComponent:
            @"1800000000.0000000-1800000000.0100000-mic.wav"]);
  Require([other promoteClosedChunksWithError:&error] == nil && error.code == 3,
          @"truncated WAV must fail closed");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  [NSFileManager.defaultManager removeItemAtPath:otherRoot error:nil];
}

static void TestSubFrameTimestampJitter(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"mic"
                                                             error:&error];
  Require(store != nil, error.localizedDescription ?: @"store must initialize");
  NSString *incoming = [root stringByAppendingPathComponent:@"mic/incoming"];
  Write(Wave(80576), [incoming stringByAppendingPathComponent:
      @"1788100044.7215020-1788100049.7575020-mic.wav"]);
  NSArray<RHChunkMetadata *> *first = [store promoteClosedChunksWithError:&error];
  Require(first.count == 1 && first[0].endUs == 1788100049757502LL,
          error.localizedDescription ?: @"first epoch-scale chunk must promote");

  Write(Wave(160), [incoming stringByAppendingPathComponent:
      @"1788100049.7575014-1788100049.7675014-mic.wav"]);
  NSArray<RHChunkMetadata *> *second = [store promoteClosedChunksWithError:&error];
  Require(second.count == 1 && second[0].startUs == first[0].endUs &&
              second[0].endUs == first[0].endUs + 10000,
          error.localizedDescription ?: @"sub-frame timestamp jitter must clamp to the prior end");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestPromotionIsAtomicAcrossScan(void) {
  NSString *root = TemporaryRoot();
  NSError *error = nil;
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"mic"
                                                             error:&error];
  Require(store != nil, error.localizedDescription ?: @"store must initialize");
  NSString *incoming = [root stringByAppendingPathComponent:@"mic/incoming"];
  NSString *firstName = @"1800000000.0000000-1800000000.0100000-mic.wav";
  NSString *secondName = @"1800000000.0100000-1800000000.0150000-mic.wav";
  Write(Wave(160), [incoming stringByAppendingPathComponent:firstName]);
  Write([@"invalid" dataUsingEncoding:NSUTF8StringEncoding],
        [incoming stringByAppendingPathComponent:secondName]);

  Require([store promoteClosedChunksWithError:&error] == nil && error.code == 3,
          @"a bad candidate must reject the complete scan");
  NSString *closed = [root stringByAppendingPathComponent:@"mic/chunks"];
  Require([NSFileManager.defaultManager fileExistsAtPath:
      [incoming stringByAppendingPathComponent:firstName]] &&
              [NSFileManager.defaultManager fileExistsAtPath:
      [incoming stringByAppendingPathComponent:secondName]] &&
              [NSFileManager.defaultManager contentsOfDirectoryAtPath:closed error:&error].count == 0,
          @"validation failure must not partially publish earlier candidates");

  Write(Wave(80), [incoming stringByAppendingPathComponent:secondName]);
  error = nil;
  Require([store promoteClosedChunksWithError:&error].count == 2,
          error.localizedDescription ?: @"a corrected scan must publish both candidates");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

static void TestTrackRootRejectsSymlink(void) {
  NSString *root = TemporaryRoot();
  NSString *target = TemporaryRoot();
  NSError *error = nil;
  Require([NSFileManager.defaultManager createDirectoryAtPath:root
                                  withIntermediateDirectories:YES attributes:nil error:&error] &&
              [NSFileManager.defaultManager createDirectoryAtPath:target
                                      withIntermediateDirectories:YES attributes:nil error:&error],
          @"symlink fixture roots must initialize");
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:
      [root stringByAppendingPathComponent:@"mic"] withDestinationPath:target error:&error],
      @"track root symlink fixture must initialize");
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"mic"
                                                             error:&error];
  Require(store == nil, @"chunk store must reject a symbolic-link track root");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  [NSFileManager.defaultManager removeItemAtPath:target error:nil];
}

static void TestIncomingChunkRejectsSymlink(void) {
  NSString *root = TemporaryRoot();
  NSString *externalRoot = TemporaryRoot();
  NSString *externalDirectory = externalRoot;
  NSString *longComponent = [@"x" stringByPaddingToLength:100 withString:@"x" startingAtIndex:0];
  for (NSUInteger index = 0; index < 4; index += 1) {
    externalDirectory = [externalDirectory stringByAppendingPathComponent:longComponent];
  }
  NSString *external = [externalDirectory stringByAppendingPathComponent:@"audio.wav"];
  NSError *error = nil;
  RHChunkStore *store = [[RHChunkStore alloc] initWithRecordingRoot:root
                                                             track:@"mic"
                                                             error:&error];
  Require(store != nil, @"chunk store must initialize for file symlink fixture");
  Require([NSFileManager.defaultManager createDirectoryAtPath:externalDirectory
                                  withIntermediateDirectories:YES attributes:nil error:&error],
          @"long symlink target directory must initialize");
  Write(Wave(160), external);
  Require(external.length > Wave(160).length,
          @"symlink target text must exceed the target WAV size for the regression");
  NSString *link = [[root stringByAppendingPathComponent:@"mic/incoming"]
      stringByAppendingPathComponent:@"1800000000.0000000-1800000000.0100000-mic.wav"];
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:link
                                             withDestinationPath:external error:&error],
          @"incoming symlink fixture must initialize");
  Require([store promoteClosedChunksWithError:&error] == nil && error.code == 3,
          @"incoming chunk validation must reject a symbolic link");
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
  [NSFileManager.defaultManager removeItemAtPath:externalRoot error:nil];
}

int main(void) {
  @autoreleasepool {
    TestPromotionAndTail();
    TestOverlapAndTruncation();
    TestSubFrameTimestampJitter();
    TestPromotionIsAtomicAcrossScan();
    TestTrackRootRejectsSymlink();
    TestIncomingChunkRejectsSymlink();
    puts("{\"chunk_store_tests\":\"passed\"}");
    return 0;
  }
}
