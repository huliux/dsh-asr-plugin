#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const RHChunkStoreErrorDomain;

@interface RHChunkMetadata : NSObject
@property(nonatomic, readonly) long long startUs;
@property(nonatomic, readonly) long long endUs;
@property(nonatomic, readonly) unsigned long long frameCount;
@property(nonatomic, readonly) BOOL hasSignal;
@property(nonatomic, readonly) NSString *path;
- (instancetype)initWithStartUs:(long long)startUs
                           endUs:(long long)endUs
                      frameCount:(unsigned long long)frameCount
                       hasSignal:(BOOL)hasSignal
                            path:(NSString *)path;
@end

@interface RHChunkStore : NSObject
@property(nonatomic, readonly) NSString *chunksRoot;
@property(nonatomic, readonly) NSString *incomingRoot;
@property(nonatomic, readonly) NSString *track;
- (nullable instancetype)initWithRecordingRoot:(NSString *)recordingRoot
                                          track:(NSString *)track
                                          error:(NSError **)error;
- (nullable NSArray<RHChunkMetadata *> *)promoteClosedChunksWithError:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
