#import <Foundation/Foundation.h>

#import <sys/types.h>

@class RHChunkMetadata;
@class RHProcessRegistry;

NS_ASSUME_NONNULL_BEGIN

typedef void (^RHChunkHandler)(RHChunkMetadata *chunk, NSString *track);
typedef void (^RHTrackStateHandler)(NSDictionary<NSString *, id> *snapshot);

@interface RHCaptureTrack : NSObject
@property(nonatomic, readonly, nullable) NSString *errorCode;
@property(nonatomic, readonly) NSString *name;
@property(nonatomic, readonly) pid_t processID;
@property(nonatomic, readonly, getter=isRequested) BOOL requested;
@property(nonatomic, readonly) NSString *state;
- (nullable instancetype)initWithName:(NSString *)name
                        recordingRoot:(NSString *)recordingRoot
                           binaryRoot:(NSString *)binaryRoot
                             registry:(RHProcessRegistry *)registry
                         chunkHandler:(nullable RHChunkHandler)chunkHandler
                         stateHandler:(nullable RHTrackStateHandler)stateHandler
                                error:(NSError **)error;
- (BOOL)requestOn:(NSError **)error;
- (BOOL)requestOff:(NSError **)error;
- (BOOL)refresh:(NSError **)error;
- (NSDictionary<NSString *, id> *)snapshot;
- (void)markRequestedFailure:(NSString *)errorCode;
- (void)stop;
@end

NS_ASSUME_NONNULL_END
