#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, RHMicrophoneAuthorization) {
  RHMicrophoneAuthorizationGranted = 0,
  RHMicrophoneAuthorizationDenied = 1,
  RHMicrophoneAuthorizationTimedOut = 2,
};

typedef RHMicrophoneAuthorization (^RHMicrophoneAuthorizer)(void);

@interface RHRecordingSession : NSObject
- (nullable instancetype)initWithSessionRoot:(NSString *)sessionRoot
                                    meetingID:(NSString *)meetingID
                                   binaryRoot:(NSString *)binaryRoot
                        microphoneAuthorizer:(RHMicrophoneAuthorizer)microphoneAuthorizer
                                        error:(NSError **)error;
- (BOOL)run;
/**
 * Pins a track to a CoreAudio device UID. An empty string keeps the macOS
 * default; the tracks are started later, so this must happen before `run`.
 */
- (BOOL)selectDeviceUID:(nullable NSString *)deviceUID forTrack:(NSString *)track;
- (BOOL)runUntil:(BOOL (^)(void))shouldStop;
@end

NS_ASSUME_NONNULL_END
