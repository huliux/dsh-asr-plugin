#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Snapshot of the audio devices CoreAudio currently exposes.
 *
 * The recording panel needs this before a recording starts so the microphone
 * button can offer the available input devices instead of only the macOS
 * default. The list is captured in the helper process because the capture
 * children already run there and the Host has no CoreAudio binding.
 */
@interface RHAudioDevice : NSObject
@property(nonatomic, readonly, copy) NSString *uid;
@property(nonatomic, readonly, copy) NSString *name;
@property(nonatomic, readonly) NSInteger inputChannels;
@property(nonatomic, readonly) NSInteger outputChannels;
@end

@interface RHAudioDeviceInventory : NSObject
@property(nonatomic, readonly, copy, nullable) NSString *defaultInputUID;
@property(nonatomic, readonly, copy, nullable) NSString *defaultOutputUID;
@property(nonatomic, readonly, copy) NSArray<RHAudioDevice *> *devices;
/** Serialized inventory for `DSHASRRecordingHelper __devices`. */
- (NSData *)jsonDataWithError:(NSError **)error;
@end

/** Reads the current CoreAudio inventory; never prompts and never records. */
RHAudioDeviceInventory *RHReadAudioDeviceInventory(void);

NS_ASSUME_NONNULL_END
