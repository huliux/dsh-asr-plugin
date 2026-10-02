#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT const NSUInteger RHJournalMaximumBytes;
FOUNDATION_EXPORT const long long RHJSONSafeIntegerMaximum;
FOUNDATION_EXPORT BOOL RHIsJSONInteger(
    id value,
    long long minimum,
    long long maximum);

typedef NS_ENUM(NSInteger, RHCommandDisposition) {
  RHCommandDispositionApply = 0,
  RHCommandDispositionDuplicate = 1,
  RHCommandDispositionInvalid = 2,
  RHCommandDispositionSequenceGap = 3,
};

@interface RHCommand : NSObject
@property(nonatomic, readonly) NSInteger commandID;
@property(nonatomic, readonly) NSString *action;
- (instancetype)initWithCommandID:(NSInteger)commandID action:(NSString *)action;
@end

FOUNDATION_EXPORT RHCommandDisposition RHParseCommandData(
    NSData *data,
    NSInteger expectedCommandID,
    RHCommand *_Nullable *_Nullable command,
    NSString *_Nullable *_Nullable errorCode);

FOUNDATION_EXPORT BOOL RHEnsureOwnerDirectory(NSString *path, NSError **error);
FOUNDATION_EXPORT NSData *_Nullable RHReadJournalFile(
    NSString *path,
    NSError **error);
FOUNDATION_EXPORT BOOL RHAtomicWriteJSON(
    NSDictionary<NSString *, id> *payload,
    NSString *path,
    NSError **error);

@interface RHEventJournal : NSObject
@property(nonatomic, readonly) NSInteger nextSequence;
- (nullable instancetype)initWithControlRoot:(NSString *)controlRoot
                                       error:(NSError **)error;
- (BOOL)appendType:(NSString *)type
            fields:(NSDictionary<NSString *, id> *)fields
             error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
