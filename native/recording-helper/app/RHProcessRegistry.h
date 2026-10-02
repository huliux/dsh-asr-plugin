#import <Foundation/Foundation.h>

#import <sys/types.h>

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  pid_t processID;
  unsigned long long startSeconds;
  unsigned long long startMicroseconds;
} RHProcessIdentity;

FOUNDATION_EXPORT NSString *RHNormalStopPath(NSString *controlRoot);
FOUNDATION_EXPORT BOOL RHMarkNormalStop(NSString *controlRoot, NSError **error);
FOUNDATION_EXPORT BOOL RHReadProcessIdentity(
    pid_t processID,
    RHProcessIdentity *identity);
FOUNDATION_EXPORT BOOL RHProcessIdentityIsAlive(RHProcessIdentity identity);
FOUNDATION_EXPORT int RHRunWatchdog(
    RHProcessIdentity helperIdentity,
    RHProcessIdentity hostIdentity,
    NSString *controlRoot,
    NSString *allowedBinaryRoot);

@interface RHProcessRegistry : NSObject
- (nullable instancetype)initWithControlRoot:(NSString *)controlRoot
                           allowedBinaryRoot:(NSString *)allowedBinaryRoot
                                       error:(NSError **)error;
- (BOOL)setPID:(pid_t)pid
    binaryPath:(NSString *)binaryPath
      forTrack:(NSString *)track
         error:(NSError **)error;
- (BOOL)clearTrack:(NSString *)track error:(NSError **)error;
- (NSUInteger)stopTrackedProcessesWithError:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
