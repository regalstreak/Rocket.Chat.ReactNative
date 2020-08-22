import React from 'react';
import PropTypes from 'prop-types';
import { View, Text } from 'react-native';
import { Audio } from 'expo-av';
import {
	LongPressGestureHandler, State, PanGestureHandler
} from 'react-native-gesture-handler';
import { getInfoAsync } from 'expo-file-system';
import { deactivateKeepAwake, activateKeepAwake } from 'expo-keep-awake';
import Animated, { Easing } from 'react-native-reanimated';

import styles from './styles';
import I18n from '../../i18n';
import { themes } from '../../constants/colors';
import { CustomIcon } from '../../lib/Icons';
import { withDimensions } from '../../dimensions';
import { isIOS, isAndroid } from '../../utils/deviceInfo';
import { SendButton } from './buttons';
import sharedStyles from '../../views/Styles';
import Touch from '../../utils/touch';
import { logEvent, events } from '../../utils/log';

const RECORDING_EXTENSION = '.aac';
const RECORDING_SETTINGS = {
	android: {
		extension: RECORDING_EXTENSION,
		outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_AAC_ADTS,
		audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
		sampleRate: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.android.sampleRate,
		numberOfChannels: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.android.numberOfChannels,
		bitRate: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.android.bitRate
	},
	ios: {
		extension: RECORDING_EXTENSION,
		audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_MIN,
		sampleRate: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.ios.sampleRate,
		numberOfChannels: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.ios.numberOfChannels,
		bitRate: Audio.RECORDING_OPTIONS_PRESET_LOW_QUALITY.ios.bitRate,
		outputFormat: Audio.RECORDING_OPTION_IOS_OUTPUT_FORMAT_MPEG4AAC
	}
};
const RECORDING_MODE = {
	allowsRecordingIOS: true,
	playsInSilentModeIOS: true,
	staysActiveInBackground: false,
	shouldDuckAndroid: true,
	playThroughEarpieceAndroid: false,
	interruptionModeIOS: Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX,
	interruptionModeAndroid: Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX
};
const RECORDING_MINIMUM_DURATION = 300;	// Cancel if recording < this duration (in ms)
const RECORDING_DEFER_END = isIOS ? 300 : 400; // Ms to wait before ending the recording
const RECORDING_TOOLTIP_DURATION = 1500; // Duration to show recording tooltip (in ms)
const RECORDING_CANCEL_DISTANCE = -120; // Swipe left gesture to cancel recording
const RECORDING_PERSIST_DISTANCE = -80; // Swipe up gesture to persist recording

const formatTime = function(seconds) {
	let minutes = Math.floor(seconds / 60);
	seconds %= 60;
	if (minutes < 10) { minutes = `0${ minutes }`; }
	if (seconds < 10) { seconds = `0${ seconds }`; }
	return `${ minutes }:${ seconds }`;
};

const {
	cond,
	eq,
	and,
	event,
	block,
	Value,
	set,
	call,
	Clock,
	startClock,
	stopClock,
	sub,
	greaterThan,
	timing,
	Extrapolate,
	neq,
	interpolate,
	lessThan,
	or,
	not
} = Animated;

function runButtonPressTimer(clock, toValue) {
	const state = {
		finished: new Value(0),
		position: new Value(0),
		time: new Value(0),
		frameTime: new Value(0)
	};

	const config = {
		duration: 180,
		toValue: new Value(-1),
		easing: Easing.inOut(Easing.ease)
	};

	return block([
		cond(and(neq(config.toValue, toValue)), [
			set(state.finished, 0),
			set(state.time, 0),
			set(state.frameTime, 0),
			set(config.toValue, toValue),
			startClock(clock)
		]),
		timing(clock, state, config),
		cond(state.finished, stopClock(clock)),
		interpolate(state.position, {
			inputRange: [0, 1],
			outputRange: [0, 80],
			extrapolate: Extrapolate.CLAMP
		})
	]);
}

const RecordingTooltip = ({ visible, theme, width }) => {
	if (!visible) { return null; }
	return (
		<View style={[styles.recordingTooltipContainer, { width }]}>
			<View
				style={[styles.recordingTooltip, {
					backgroundColor: themes[theme].bannerBackground,
					borderColor: themes[theme].borderColor
				}]}
			>
				<Text style={[sharedStyles.textRegular, { color: themes[theme].bodyText }]}>
					{I18n.t('Recording_tooltip')}
				</Text>
			</View>

		</View>
	);
};

RecordingTooltip.propTypes = {
	visible: PropTypes.bool,
	theme: PropTypes.string,
	width: PropTypes.number
};

class RecordAudio extends React.PureComponent {
	static propTypes = {
		theme: PropTypes.string,
		recordingCallback: PropTypes.func,
		onFinish: PropTypes.func,
		width: PropTypes.number
	}

	constructor(props) {
		super(props);

		this.isRecorderBusy = false;
		this.longPressRef = React.createRef();
		this.panRef = React.createRef();

		this.state = {
			isRecording: false,
			recordingDurationMillis: 0,
			isRecordingTooltipVisible: false,
			isRecordingPersisted: false
		};

		const touchX = new Value(0);
		const touchY = new Value(0);

		const buttonPressToValue = new Value(0);
		const buttonPressClock = new Clock();

		const isRecordingCancelledValue = new Value(0);
		const isRecordingPersistedValue = new Value(0);

		const longPressClock = new Clock();
		const longPressStartTime = new Value(0);
		const isLongPressStarted = new Value(0);

		const isPanStarted = new Value(0);

		this._onLongPress = event([{
			nativeEvent: ({ state }) => block([

				cond(and(eq(state, State.ACTIVE), eq(isLongPressStarted, 0)), [
					set(isLongPressStarted, 1),
					set(isRecordingCancelledValue, 0),
					set(isRecordingPersistedValue, 0),
					startClock(longPressClock),
					set(longPressStartTime, longPressClock),
					set(buttonPressToValue, 1),
					call([], this.startRecordingAudio)
				]),

				cond(and(eq(state, State.END), eq(isLongPressStarted, 1), eq(isRecordingPersistedValue, 0), eq(isIOS, 1)), [
					set(isLongPressStarted, 0),
					set(buttonPressToValue, 0),
					stopClock(longPressClock),
					cond(greaterThan(sub(longPressClock, longPressStartTime), RECORDING_MINIMUM_DURATION), [
						call([], this.finishRecordingAudio)
					], [
						call([], () => this.cancelRecordingAndShowTooltip(RECORDING_DEFER_END))
					])
				])
			])
		}]);

		this._onPan = event([{
			nativeEvent: ({ translationX, translationY, state }) => block([
				set(touchX, translationX),
				set(touchY, translationY),

				cond(eq(state, State.ACTIVE), [
					cond(eq(isPanStarted, 0), [
						set(isPanStarted, 1)
					]),
					cond(and(lessThan(translationX, RECORDING_CANCEL_DISTANCE), eq(isRecordingCancelledValue, 0), eq(isRecordingPersistedValue, 0)), [
						set(isRecordingCancelledValue, 1),
						call([], this.cancelRecordingAudio),
						set(isLongPressStarted, 0),
						stopClock(longPressClock),
						set(buttonPressToValue, 0)
					]),
					cond(and(lessThan(translationY, RECORDING_PERSIST_DISTANCE), eq(isRecordingPersistedValue, 0), eq(isRecordingCancelledValue, 0)), [
						set(isRecordingPersistedValue, 1),
						set(isLongPressStarted, 0),
						stopClock(longPressClock),
						call([], () => this.setState({ isRecordingPersisted: true })),
						set(buttonPressToValue, 0)
					])
				]),

				cond(and(eq(state, State.END), eq(isPanStarted, 1)), [
					set(isPanStarted, 0),
					cond(and(eq(isRecordingPersistedValue, 0), eq(isAndroid, 1)), [
						set(isLongPressStarted, 0),
						set(buttonPressToValue, 0),
						stopClock(longPressClock),
						cond(greaterThan(sub(longPressClock, longPressStartTime), RECORDING_MINIMUM_DURATION), [
							call([], this.finishRecordingAudio)
						], [
							call([], () => this.cancelRecordingAndShowTooltip(RECORDING_DEFER_END))
						])
					])
				])
			])
		}]);

		const translationZeroCondition = or(not(isPanStarted), eq(isRecordingCancelledValue, 1), eq(isRecordingPersistedValue, 1));

		this._cancelTranslationX = cond(or(greaterThan(touchX, 0), translationZeroCondition), 0, touchX);
		this._persistTranslationY = cond(or(greaterThan(touchY, 0), translationZeroCondition), 0, touchY);
		this._buttonGrow = runButtonPressTimer(buttonPressClock, buttonPressToValue);
	}

	componentDidUpdate() {
		const { recordingCallback } = this.props;
		const { isRecording } = this.state;

		recordingCallback(isRecording);
	}

	componentWillUnmount() {
		if (this.recording) {
			this.cancelRecordingAudio();
		}
	}

	get duration() {
		const { recordingDurationMillis } = this.state;
		return formatTime(Math.floor(recordingDurationMillis / 1000));
	}

	isRecordingPermissionGranted = async() => {
		try {
			const permission = await Audio.getPermissionsAsync();
			if (permission.status === 'granted') {
				return true;
			}
			await Audio.requestPermissionsAsync();
		} catch {
			// Do nothing
		}
		return false;
	}

	onRecordingStatusUpdate = (status) => {
		this.setState({
			isRecording: status.isRecording,
			recordingDurationMillis: status.durationMillis
		});
	}

	startRecordingAudio = async() => {
		logEvent(events.ROOM_AUDIO_RECORD);
		const { isRecording } = this.state;

		if (!this.isRecorderBusy && !isRecording) {
			this.isRecorderBusy = true;
			this.setState({ isRecordingPersisted: false });
			try {
				const canRecord = await this.isRecordingPermissionGranted();
				if (canRecord) {
					await Audio.setAudioModeAsync(RECORDING_MODE);

					this.recording = new Audio.Recording();
					await this.recording.prepareToRecordAsync(RECORDING_SETTINGS);
					this.recording.setOnRecordingStatusUpdate(this.onRecordingStatusUpdate);

					await this.recording.startAsync();
					activateKeepAwake();
				} else {
					await Audio.requestPermissionsAsync();
				}
			} catch (error) {
				logEvent(events.ROOM_AUDIO_RECORD_F);
			}
			this.isRecorderBusy = false;
		}
	};

	finishRecordingAudio = async() => {
		logEvent(events.ROOM_AUDIO_FINISH);
		if (!this.isRecorderBusy) {
			const { onFinish } = this.props;

			this.isRecorderBusy = true;
			try {
				await this.recording.stopAndUnloadAsync();

				const fileURI = this.recording.getURI();
				const fileData = await getInfoAsync(fileURI);
				const fileInfo = {
					name: `${ Date.now() }.aac`,
					mime: 'audio/aac',
					type: 'audio/aac',
					store: 'Uploads',
					path: fileURI,
					size: fileData.size
				};

				onFinish(fileInfo);
			} catch (error) {
				logEvent(events.ROOM_AUDIO_FINISH_F);
			}
			this.setState({ isRecording: false, recordingDurationMillis: 0, isRecordingPersisted: false });
			deactivateKeepAwake();
			this.isRecorderBusy = false;
		}
	};

	cancelRecordingAudio = async() => {
		logEvent(events.ROOM_AUDIO_CANCEL);
		if (!this.isRecorderBusy) {
			this.isRecorderBusy = true;
			try {
				await this.recording.stopAndUnloadAsync();
			} catch (error) {
				logEvent(events.ROOM_AUDIO_CANCEL_F);
			}
			this.setState({ isRecording: false, recordingDurationMillis: 0, isRecordingPersisted: false });
			deactivateKeepAwake();
			this.isRecorderBusy = false;
		}
	};

	cancelRecordingAndShowTooltip = (deferDuration) => {
		setTimeout(() => {
			this.cancelRecordingAudio();
		}, deferDuration);
		this.setState({ isRecordingTooltipVisible: true });
		setTimeout(() => {
			this.setState({ isRecordingTooltipVisible: false });
		}, RECORDING_TOOLTIP_DURATION);
	}

	render() {
		const { theme, width } = this.props;
		const { isRecording, isRecordingTooltipVisible, isRecordingPersisted } = this.state;

		const buttonIconColor = isRecording ? themes[theme].focusedBackground : themes[theme].tintColor;

		return (
			<>
				<RecordingTooltip visible={isRecordingTooltipVisible} theme={theme} width={width} />

				{
					isRecording && (
						<Animated.View style={styles.recordingContent}>
							<Text
								style={[styles.recordingDurationText, { color: themes[theme].titleText }]}
							>
								{this.duration}
							</Text>
							{
								isRecordingPersisted ? (
									<View style={styles.recordingSlideToCancel}>
										<Touch
											onPress={this.cancelRecordingAudio}
											style={styles.recordingCancelButton}
											theme={theme}
										>
											<Text style={[sharedStyles.textMedium, { color: themes[theme].tintColor }]}>
												{I18n.t('Recording_cancel_button')}
											</Text>
										</Touch>
									</View>
								) : (
									<Animated.View style={[styles.recordingSlideToCancel, { transform: [{ translateX: this._cancelTranslationX }] }]}>
										<CustomIcon name='chevron-left' size={32} color={themes[theme].auxiliaryTintColor} />
										<Text style={[sharedStyles.textMedium, {
											color: themes[theme].auxiliaryText
										}]}
										>
											{I18n.t('Recording_slide_to_cancel')}
										</Text>
									</Animated.View>
								)
							}
						</Animated.View>
					)
				}

				{
					isRecordingPersisted ? <SendButton theme={theme} onPress={this.finishRecordingAudio} /> : null
				}

				<PanGestureHandler
					ref={this.panRef}
					minDist={0}
					simultaneousHandlers={[this.longPressRef]}
					onGestureEvent={this._onPan}
					onHandlerStateChange={this._onPan}
				>
					<Animated.View>
						<LongPressGestureHandler
							ref={this.longPressRef}
							simultaneousHandlers={[this.panRef]}
							onHandlerStateChange={this._onLongPress}
							minDurationMs={0}
						>
							{
								isRecordingPersisted ? <Animated.View /> : (
									<Animated.View
										style={[styles.actionButton, { transform: [{ translateY: this._persistTranslationY }] }]}
										testID='messagebox-send-audio'
										accessibilityLabel={I18n.t('Send_audio_message')}
										accessibilityTraits='button'
									>
										<View style={styles.recordingButtonBubbleContainer}>
											<Animated.View
												style={[styles.recordingButtonBubble, {
													backgroundColor: themes[theme].tintColor,
													width: this._buttonGrow,
													height: this._buttonGrow
												}]}
											/>
										</View>
										<CustomIcon name='microphone' size={24} color={buttonIconColor} />
									</Animated.View>
								)
							}
						</LongPressGestureHandler>
					</Animated.View>
				</PanGestureHandler>
			</>
		);
	}
}

export default withDimensions(RecordAudio);
