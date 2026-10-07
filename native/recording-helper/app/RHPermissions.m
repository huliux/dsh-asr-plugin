#import "RHPermissions.h"

#import <AVFoundation/AVFoundation.h>
#import "RHSystemAudioProbe.h"
#import "RHProcessRegistry.h"
#import <fcntl.h>
#import <unistd.h>

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

static NSString *RHMicrophoneStatus(void) {
  switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized: return @"granted";
    case AVAuthorizationStatusDenied: return @"denied";
    case AVAuthorizationStatusRestricted: return @"restricted";
    default: return @"notDetermined";
  }
}

static dispatch_source_t RHPermissionDeadline(NSString *root, RHProcessIdentity host) {
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
    dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
  double start = NSProcessInfo.processInfo.systemUptime;
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    if (!RHProcessIdentityIsAlive(host) ||
        [NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@"cancel"]] ||
        NSProcessInfo.processInfo.systemUptime - start > 45) _exit(75);
  });
  dispatch_resume(timer);
  return timer;
}

int RHCheckRecordingPermissions(NSString *root, BOOL test, pid_t hostProcessID) {
  RHProcessIdentity host = {};
  if (!RHReadProcessIdentity(hostProcessID, &host)) return 64;
  dispatch_source_t timer = RHPermissionDeadline(root, host);
  NSString *microphone = RHMicrophoneStatus();
  if (test && [microphone isEqualToString:@"notDetermined"]) {
    RHRequestMicrophoneAuthorization(40);
    microphone = RHMicrophoneStatus();
  }
  NSString *system = @"unverified";
  if (@available(macOS 14.2, *)) {
    if (test && [microphone isEqualToString:@"granted"] && RHVerifySystemAudio()) system = @"verified";
  } else system = @"unsupported";
  NSData *response = [NSJSONSerialization dataWithJSONObject:@{
    @"microphone": microphone, @"system": system } options:0 error:nil];
  NSString *path = [root stringByAppendingPathComponent:@"permissions.json"];
  int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  BOOL written = fd >= 0 && write(fd, response.bytes, response.length) == response.length;
  if (fd >= 0) close(fd);
  dispatch_source_cancel(timer);
  return written ? 0 : 74;
}
