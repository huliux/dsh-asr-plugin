#import <Foundation/Foundation.h>

#import "RHRecordingSession.h"

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT RHMicrophoneAuthorization RHRequestMicrophoneAuthorization(
    NSTimeInterval timeoutSeconds);

FOUNDATION_EXPORT int RHCheckRecordingPermissions(NSString *root, BOOL test, pid_t hostProcessID);

NS_ASSUME_NONNULL_END
