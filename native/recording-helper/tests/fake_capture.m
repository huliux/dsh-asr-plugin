#import <Foundation/Foundation.h>
#import <signal.h>
#import <unistd.h>

static volatile sig_atomic_t gStop = 0;

static void Stop(int signalNumber) {
  (void)signalNumber;
  gStop = 1;
}

static void Put16(NSMutableData *data, uint16_t value) {
  uint16_t little = CFSwapInt16HostToLittle(value);
  [data appendBytes:&little length:2];
}

static void Put32(NSMutableData *data, uint32_t value) {
  uint32_t little = CFSwapInt32HostToLittle(value);
  [data appendBytes:&little length:4];
}

static void WriteWave(NSString *directory, NSString *track, double start, NSUInteger frames, BOOL signal) {
  uint32_t dataBytes = (uint32_t)(frames * 2);
  NSMutableData *data = [NSMutableData data];
  [data appendBytes:"RIFF" length:4];
  Put32(data, 36 + dataBytes);
  [data appendBytes:"WAVEfmt " length:8];
  Put32(data, 16); Put16(data, 1); Put16(data, 1); Put32(data, 16000);
  Put32(data, 32000); Put16(data, 2); Put16(data, 16);
  [data appendBytes:"data" length:4]; Put32(data, dataBytes);
  [data increaseLengthBy:dataBytes];
  if (signal) ((uint8_t *)data.mutableBytes)[44] = 1;
  double end = start + (double)frames / 16000.0;
  NSString *name = [NSString stringWithFormat:@"%.7f-%.7f-%@.wav", start, end, track];
  [data writeToFile:[directory stringByAppendingPathComponent:name] atomically:NO];
}

static void WriteInvalidWave(NSString *directory, NSString *track, double start) {
  NSString *name = [NSString stringWithFormat:@"%.7f-%.7f-%@.wav",
      start, start + 0.005, track];
  [@"invalid" writeToFile:[directory stringByAppendingPathComponent:name]
                atomically:NO encoding:NSUTF8StringEncoding error:nil];
}

static NSString *Argument(int argc, const char *argv[], NSString *key) {
  for (int index = 1; index + 1 < argc; index += 1) {
    if ([[NSString stringWithUTF8String:argv[index]] isEqualToString:key]) {
      return [NSString stringWithUTF8String:argv[index + 1]];
    }
  }
  return nil;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGTERM, Stop);
    signal(SIGINT, Stop);
    NSString *directory = Argument(argc, argv, @"--output-dir");
    NSString *source = Argument(argc, argv, @"--recording-source");
    NSString *logPath = Argument(argc, argv, @"--default-log-file");
    NSString *dataPath = Argument(argc, argv, @"--data-path");
    if (directory == nil || source == nil || ![logPath isEqualToString:@"/dev/null"] ||
        dataPath != nil) return 64;
    NSString *track = [source isEqualToString:@"microphone"] ? @"mic" : @"system";
    if ([track isEqualToString:@"mic"]) puts("### AUDIO PERMISSION: OK TO RECORD");
    puts("Audio recording process started");
    fflush(stdout);
    double start = NSDate.date.timeIntervalSince1970;
    NSString *invalidOnlineTrack =
        NSProcessInfo.processInfo.environment[@"RH_FAKE_INVALID_ONLINE_TRACK"];
    BOOL silentStart = [NSProcessInfo.processInfo.environment[@"RH_FAKE_SILENT_START"] isEqualToString:@"1"];
    if (silentStart) {
      NSString *closed = [[directory stringByDeletingLastPathComponent]
          stringByAppendingPathComponent:@"chunks"];
      for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:closed error:nil]) {
        NSArray *times = [[name stringByDeletingPathExtension] componentsSeparatedByString:@"-"];
        if (times.count == 2) start = MAX(start, [times[1] doubleValue] / 1000000.0);
      }
    }
    if ([invalidOnlineTrack isEqualToString:track]) {
      WriteInvalidWave(directory, track, start);
    } else {
      WriteWave(directory, track, start, silentStart ? 80000 : 160, NO);
    }
    if (silentStart) {
      usleep(1000000);
      WriteWave(directory, track, start + 5.0, 160, YES);
    }
    while (!gStop) usleep(10000);
    if ([NSProcessInfo.processInfo.environment[@"RH_FAKE_INVALID_TAIL"] isEqualToString:@"1"]) {
      WriteInvalidWave(directory, track, start + 0.010);
    } else {
      WriteWave(directory, track, start + (silentStart ? 5.010 : 0.010), 80, NO);
    }
    return 0;
  }
}
