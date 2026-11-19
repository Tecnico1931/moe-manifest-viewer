/**
 * Captures when a <video> first renders a frame, as performance.now() (the clock RequestLogService uses).
 * Uses requestVideoFrameCallback after 'playing' when the browser has it (the frame is actually presented),
 * else the 'playing' event. 'loadeddata' is not used: a paused, muted-autoplay-blocked video fires it without
 * ever showing a frame being played. Scoped to the one element it is given, so each viewer has its own.
 */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface FirstFrameWatch {
  /** Forget the captured frame and wait for a new one (new load on the same element). */
  rearm: () => void;
  dispose: () => void;
}

export const watchFirstFrame = (
  video: HTMLVideoElement,
  onFrame: (perfNow: number) => void,
  onChange: (isNewLoad: boolean) => void
): FirstFrameWatch => {
  const v = video as FrameCallbackVideo;
  let done = false;
  let handle: number | undefined;

  const cancel = () => {
    if (handle !== undefined && v.cancelVideoFrameCallback) {
      v.cancelVideoFrameCallback(handle);
    }
    handle = undefined;
  };
  const emit = (t: number) => {
    if (!done) {
      done = true;
      cancel();
      onFrame(t);
    }
  };
  const onPlaying = () => {
    if (done) {
      return;
    }
    if (v.requestVideoFrameCallback) {
      if (handle === undefined) {
        handle = v.requestVideoFrameCallback((now) => emit(now));
      }
    } else {
      emit(performance.now());
    }
  };
  const rearm = () => {
    cancel();
    done = false;
  };
  const onReload = () => {
    rearm();
    onChange(true);
  };

  v.addEventListener('playing', onPlaying);
  v.addEventListener('emptied', onReload);
  v.addEventListener('loadstart', onReload);
  const onPassive = () => onChange(false);
  const passive = ['pause', 'loadeddata', 'canplay', 'waiting', 'play'];
  passive.forEach((e) => v.addEventListener(e, onPassive));
  return {
    rearm,
    dispose: () => {
      cancel();
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('emptied', onReload);
      v.removeEventListener('loadstart', onReload);
      passive.forEach((e) => v.removeEventListener(e, onPassive));
    },
  };
};
