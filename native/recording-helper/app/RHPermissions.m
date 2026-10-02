#import "RHPermissions.h"

#import <AVFoundation/AVFoundation.h>

RHMicrophoneAuthorization RHRequestMicrophoneAuthorization(NSTimeInterval timeoutSeconds) {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (status == AVAuthorizationStatusAuthorized) return RHMicrophoneAuthorizationGranted;
  if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
    return RHMicrophoneAuthorizationDenied;
  }
  if (status != AVAuthorizationStatusNotDetermined) return RHMicrophoneAuthorizationDenied;

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block BOOL granted = NO;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL value) {
    granted = value;
    dispatch_semaphore_signal(semaphore);
  }];
  int64_t nanoseconds = (int64_t)(MAX(timeoutSeconds, 0.0) * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, nanoseconds)) != 0) {
    return RHMicrophoneAuthorizationTimedOut;
  }
  return granted ? RHMicrophoneAuthorizationGranted : RHMicrophoneAuthorizationDenied;
}
