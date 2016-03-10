/**
 * videojs-hls
 * The main file for the HLS project.
 * License: https://github.com/videojs/videojs-contrib-hls/blob/master/LICENSE
 */
import PlaylistLoader from './playlist-loader';
import Playlist from './playlist';
import xhr from './xhr';
import {Decrypter, AsyncStream, decrypt} from './decrypter';
import utils from './bin-utils';
import {MediaSource, URL} from 'videojs-contrib-media-sources';
import m3u8 from './m3u8';
import videojs from 'video.js';
import resolveUrl from './resolve-url';
import SegmentLoader from './segment-loader';
import Ranges from './ranges';
import MasterPlaylistController from './master-playlist-controller';

const Hls = {
  PlaylistLoader,
  Playlist,
  Decrypter,
  AsyncStream,
  decrypt,
  utils,
  xhr
};

// the desired length of video to maintain in the buffer, in seconds
Hls.GOAL_BUFFER_LENGTH = 30;

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
Hls.canPlaySource = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

/**
 * Whether the browser has built-in HLS support.
 */
Hls.supportsNativeHls = (function() {
  let video = document.createElement('video');
  let xMpegUrl;
  let vndMpeg;

  // native HLS is definitely not supported if HTML5 video isn't
  if (!videojs.getComponent('Html5').isSupported()) {
    return false;
  }

  xMpegUrl = video.canPlayType('application/x-mpegURL');
  vndMpeg = video.canPlayType('application/vnd.apple.mpegURL');
  return (/probably|maybe/).test(xMpegUrl) ||
    (/probably|maybe/).test(vndMpeg);
}());

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
Hls.isSupported = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

const Component = videojs.getComponent('Component');

const parseCodecs = function(codecs) {
  let result = {
    codecCount: 0,
    videoCodec: null,
    audioProfile: null
  };

  result.codecCount = codecs.split(',').length;
  result.codecCount = result.codecCount || 2;

  // parse the video codec but ignore the version
  result.videoCodec = (/(^|\s|,)+(avc1)[^ ,]*/i).exec(codecs);
  result.videoCodec = result.videoCodec && result.videoCodec[2];

  // parse the last field of the audio codec
  result.audioProfile = (/(^|\s|,)+mp4a.\d+\.(\d+)/i).exec(codecs);
  result.audioProfile = result.audioProfile && result.audioProfile[2];

  return result;
};

export default class HlsHandler extends Component {
  constructor(tech, options) {
    super(tech);
    let _player;

    // tech.player() is deprecated but setup a reference to HLS for
    // backwards-compatibility
    if (tech.options_ && tech.options_.playerId) {
      _player = videojs(tech.options_.playerId);
      if (!_player.hls) {
        Object.defineProperty(_player, 'hls', {
          get: () => {
            videojs.log.warn('player.hls is deprecated. Use player.tech.hls instead.');
            return this;
          }
        });
      }
    }
    this.tech_ = tech;
    this.source_ = options.source;
    this.mode_ = options.mode;
    // the segment info object for a segment that is in the process of
    // being downloaded or processed
    this.pendingSegment_ = null;

    // start playlist selection at a reasonable bandwidth for
    // broadband internet
    // 0.5 Mbps
    this.bandwidth = options.bandwidth || 4194304;
    this.bytesReceived = 0;

    // loadingState_ tracks how far along the buffering process we
    // have been given permission to proceed. There are three possible
    // values:
    // - none: do not load playlists or segments
    // - meta: load playlists but not segments
    // - segments: load everything
    this.loadingState_ = 'none';
    if (this.tech_.preload() !== 'none') {
      this.loadingState_ = 'meta';
    }

    this.on(this.tech_, 'seeking', function() {
      this.setCurrentTime(this.tech_.currentTime());
    });
    this.on(this.tech_, 'error', function() {
      if (this.masterPlaylistController_) {
        this.masterPlaylistController_.pause();
      }
    });

    this.on(this.tech_, 'play', this.play);
  }
  src(src) {
    // do nothing if the src is falsey
    if (!src) {
      return;
    }

    this.mediaSource = new videojs.MediaSource({ mode: this.mode_ });

    // load the MediaSource into the player
    this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen.bind(this));

    this.options_ = {};
    if (typeof this.source_.withCredentials !== 'undefined') {
      this.options_.withCredentials = this.source_.withCredentials;
    } else if (videojs.options.hls) {
      this.options_.withCredentials = videojs.options.hls.withCredentials;
    }

    this.masterPlaylistController_ = new MasterPlaylistController({
      url: this.source_.src,
      withCredentials: this.options_.withCredentials,
      currentTimeFunc: this.tech_.currentTime.bind(this.tech_),
      mediaSource: this.mediaSource,
      hlsHandler: this,
      externHls: Hls
    });

    this.tech_.one('canplay', this.setupFirstPlay.bind(this));

    // do nothing if the tech has been disposed already
    // this can occur if someone sets the src in player.ready(), for instance
    if (!this.tech_.el()) {
      return;
    }

    this.tech_.src(videojs.URL.createObjectURL(this.mediaSource));
  }
  handleSourceOpen() {
    // Only attempt to create the source buffer if none already exist.
    // handleSourceOpen is also called when we are "re-opening" a source buffer
    // after `endOfStream` has been called (in response to a seek for instance)
    if (!this.sourceBuffer) {
      this.setupSourceBuffer_();
    }

    // if autoplay is enabled, begin playback. This is duplicative of
    // code in video.js but is required because play() must be invoked
    // *after* the media source has opened.
    // NOTE: moving this invocation of play() after
    // sourceBuffer.appendBuffer() below caused live streams with
    // autoplay to stall
    if (this.tech_.autoplay()) {
      this.play();
    }
  }

  /**
   * Blacklist playlists that are known to be codec or
   * stream-incompatible with the SourceBuffer configuration. For
   * instance, Media Source Extensions would cause the video element to
   * stall waiting for video data if you switched from a variant with
   * video and audio to an audio-only one.
   *
   * @param media {object} a media playlist compatible with the current
   * set of SourceBuffers. Variants in the current master playlist that
   * do not appear to have compatible codec or stream configurations
   * will be excluded from the default playlist selection algorithm
   * indefinitely.
   */
  excludeIncompatibleVariants_(media) {
    let master = this.playlists.master;
    let codecCount = 2;
    let videoCodec = null;
    let audioProfile = null;
    let codecs;

    if (media.attributes && media.attributes.CODECS) {
      codecs = parseCodecs(media.attributes.CODECS);
      videoCodec = codecs.videoCodec;
      audioProfile = codecs.audioProfile;
      codecCount = codecs.codecCount;
    }
    master.playlists.forEach(function(variant) {
      let variantCodecs = {
        codecCount: 2,
        videoCodec: null,
        audioProfile: null
      };

      if (variant.attributes && variant.attributes.CODECS) {
        variantCodecs = parseCodecs(variant.attributes.CODECS);
      }

      // if the streams differ in the presence or absence of audio or
      // video, they are incompatible
      if (variantCodecs.codecCount !== codecCount) {
        variant.excludeUntil = Infinity;
      }

      // if h.264 is specified on the current playlist, some flavor of
      // it must be specified on all compatible variants
      if (variantCodecs.videoCodec !== videoCodec) {
        variant.excludeUntil = Infinity;
      }
      // HE-AAC ("mp4a.40.5") is incompatible with all other versions of
      // AAC audio in Chrome 46. Don't mix the two.
      if ((variantCodecs.audioProfile === '5' && audioProfile !== '5') ||
          (audioProfile === '5' && variantCodecs.audioProfile !== '5')) {
        variant.excludeUntil = Infinity;
      }
    });
  }

  setupSourceBuffer_() {
    let media = this.playlists.media();
    let mimeType;

    // wait until a media playlist is available and the Media Source is
    // attached
    if (!media || this.mediaSource.readyState !== 'open') {
      return;
    }

    // if the codecs were explicitly specified, pass them along to the
    // source buffer
    mimeType = 'video/mp2t';
    if (media.attributes && media.attributes.CODECS) {
      mimeType += '; codecs="' + media.attributes.CODECS + '"';
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

    // exclude any incompatible variant streams from future playlist
    // selection
    this.excludeIncompatibleVariants_(media);
  }

  /**
   * Seek to the latest media position if this is a live video and the
   * player and video are loaded and initialized.
   */
  setupFirstPlay() {
    let seekable;
    let media = this.playlists.media();

    // check that everything is ready to begin buffering

    // 1) the video is a live stream of unknown duration
    if (this.duration() === Infinity &&

        // 2) the player has not played before and is not paused
        this.tech_.played().length === 0 &&
        !this.tech_.paused() &&

        // 3) the Media Source and Source Buffers are ready
        this.sourceBuffer &&

        // 4) the active media playlist is available
        media &&

        // 5) the video element or flash player is in a readyState of
        // at least HAVE_FUTURE_DATA
        this.tech_.readyState() >= 1) {

      // trigger the playlist loader to start "expired time"-tracking
      this.playlists.trigger('firstplay');

      // seek to the latest media position for live videos
      seekable = this.seekable();
      if (seekable.length) {
        this.tech_.setCurrentTime(seekable.end(0));
      }
    }
  }

  /**
   * Begin playing the video.
   */
  play() {
    this.loadingState_ = 'segments';

    if (this.tech_.ended()) {
      this.tech_.setCurrentTime(0);
    }

    if (this.tech_.played().length === 0) {
      return this.setupFirstPlay();
    }

    // if the viewer has paused and we fell out of the live window,
    // seek forward to the earliest available position
    if (this.duration() === Infinity) {
      if (this.tech_.currentTime() < this.seekable().start(0)) {
        this.tech_.setCurrentTime(this.seekable().start(0));
      }
    }
  }

  setCurrentTime(currentTime) {
    this.masterPlaylistController_.setCurrentTime(currentTime);
  }

  duration() {
    let playlists = this.playlists;

    if (!playlists) {
      return 0;
    }

    if (this.mediaSource) {
      return this.mediaSource.duration;
    }

    return Hls.Playlist.duration(playlists.media());
  }

  seekable() {
    let media;
    let seekable;

    if (!this.playlists) {
      return videojs.createTimeRanges();
    }
    media = this.playlists.media();
    if (!media) {
      return videojs.createTimeRanges();
    }

    seekable = Hls.Playlist.seekable(media);
    if (seekable.length === 0) {
      return seekable;
    }

    // if the seekable start is zero, it may be because the player has
    // been paused for a long time and stopped buffering. in that case,
    // fall back to the playlist loader's running estimate of expired
    // time
    if (seekable.start(0) === 0) {
      return videojs.createTimeRanges([[this.playlists.expired_,
                                        this.playlists.expired_ + seekable.end(0)]]);
    }

    // seekable has been calculated based on buffering video data so it
    // can be returned directly
    return seekable;
  }

  /**
   * Update the player duration
   */
  updateDuration(playlist) {
    let oldDuration = this.mediaSource.duration;
    let newDuration = Hls.Playlist.duration(playlist);
    let buffered = this.tech_.buffered();
    let setDuration = () => {
      this.mediaSource.duration = newDuration;
      this.tech_.trigger('durationchange');

      this.mediaSource.removeEventListener('sourceopen', setDuration);
    };

    if (buffered.length > 0) {
      newDuration = Math.max(newDuration, buffered.end(buffered.length - 1));
    }

    // if the duration has changed, invalidate the cached value
    if (oldDuration !== newDuration) {
      // update the duration
      if (this.mediaSource.readyState !== 'open') {
        this.mediaSource.addEventListener('sourceopen', setDuration);
      } else if (!this.sourceBuffer || !this.sourceBuffer.updating) {
        this.mediaSource.duration = newDuration;
        this.tech_.trigger('durationchange');
      }
    }
  }

  /**
   * Clear all buffers and reset any state relevant to the current
   * source. After this function is called, the tech should be in a
   * state suitable for switching to a different video.
   */
  resetSrc_() {
    if (this.sourceBuffer && this.mediaSource.readyState === 'open') {
      this.sourceBuffer.abort();
    }
  }

  /**
  * Abort all outstanding work and cleanup.
  */
  dispose() {
    if (this.masterPlaylistController_) {
      this.masterPlaylistController_.dispose();
    }

    this.resetSrc_();
    super.dispose();
  }

  playlistUriToUrl(segmentRelativeUrl) {
    let playListUrl;

      // resolve the segment URL relative to the playlist
    if (this.playlists.media().uri === this.source_.src) {
      playListUrl = resolveUrl(this.source_.src, segmentRelativeUrl);
    } else {
      playListUrl =
        resolveUrl(resolveUrl(this.source_.src, this.playlists.media().uri || ''),
                   segmentRelativeUrl);
    }
    return playListUrl;
  }

  /*
   * Sets `bandwidth`, `segmentXhrTime`, and appends to the `bytesReceived.
   * Expects an object with:
   *  * `roundTripTime` - the round trip time for the request we're setting the time for
   *  * `bandwidth` - the bandwidth we want to set
   *  * `bytesReceived` - amount of bytes downloaded
   * `bandwidth` is the only required property.
   */
  setBandwidth(localXhr) {
    // calculate the download bandwidth
    this.segmentXhrTime = localXhr.roundTripTime;
    this.bandwidth = localXhr.bandwidth;
    this.bytesReceived += localXhr.bytesReceived || 0;

    this.tech_.trigger('bandwidthupdate');
  }
}

/**
 * The Source Handler object, which informs video.js what additional
 * MIME types are supported and sets up playback. It is registered
 * automatically to the appropriate tech based on the capabilities of
 * the browser it is running in. It is not necessary to use or modify
 * this object in normal usage.
 */
const HlsSourceHandler = function(mode) {
  return {
    canHandleSource(srcObj) {
      return HlsSourceHandler.canPlayType(srcObj.type);
    },
    handleSource(source, tech) {
      if (mode === 'flash') {
        // We need to trigger this asynchronously to give others the chance
        // to bind to the event when a source is set at player creation
        tech.setTimeout(function() {
          tech.trigger('loadstart');
        }, 1);
      }
      tech.hls = new HlsHandler(tech, {
        source,
        mode
      });
      tech.hls.src(source.src);
      return tech.hls;
    },
    canPlayType(type) {
      return HlsSourceHandler.canPlayType(type);
    }
  };
};

/**
 * A comparator function to sort two playlist object by bandwidth.
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the bandwidth attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the bandwidth of right is greater than left and
 * exactly zero if the two are equal.
 */
Hls.comparePlaylistBandwidth = function(left, right) {
  let leftBandwidth;
  let rightBandwidth;

  if (left.attributes && left.attributes.BANDWIDTH) {
    leftBandwidth = left.attributes.BANDWIDTH;
  }
  leftBandwidth = leftBandwidth || window.Number.MAX_VALUE;
  if (right.attributes && right.attributes.BANDWIDTH) {
    rightBandwidth = right.attributes.BANDWIDTH;
  }
  rightBandwidth = rightBandwidth || window.Number.MAX_VALUE;

  return leftBandwidth - rightBandwidth;
};

/**
 * A comparator function to sort two playlist object by resolution (width).
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the resolution.width attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the resolution.width of right is greater than left and
 * exactly zero if the two are equal.
 */
Hls.comparePlaylistResolution = function(left, right) {
  let leftWidth;
  let rightWidth;

  if (left.attributes &&
      left.attributes.RESOLUTION &&
      left.attributes.RESOLUTION.width) {
    leftWidth = left.attributes.RESOLUTION.width;
  }

  leftWidth = leftWidth || window.Number.MAX_VALUE;

  if (right.attributes &&
      right.attributes.RESOLUTION &&
      right.attributes.RESOLUTION.width) {
    rightWidth = right.attributes.RESOLUTION.width;
  }

  rightWidth = rightWidth || window.Number.MAX_VALUE;

  // NOTE - Fallback to bandwidth sort as appropriate in cases where multiple renditions
  // have the same media dimensions/ resolution
  if (leftWidth === rightWidth &&
      left.attributes.BANDWIDTH &&
      right.attributes.BANDWIDTH) {
    return left.attributes.BANDWIDTH - right.attributes.BANDWIDTH;
  }
  return leftWidth - rightWidth;
};

HlsSourceHandler.canPlayType = function(type) {
  let mpegurlRE = /^application\/(?:x-|vnd\.apple\.)mpegurl/i;

  // favor native HLS support if it's available
  if (Hls.supportsNativeHls) {
    return false;
  }
  return mpegurlRE.test(type);
};

if (typeof videojs.MediaSource === 'undefined' ||
    typeof videojs.URL === 'undefined') {
  videojs.MediaSource = MediaSource;
  videojs.URL = URL;
}

// register source handlers with the appropriate techs
if (MediaSource.supportsNativeMediaSources()) {
  videojs.getComponent('Html5').registerSourceHandler(HlsSourceHandler('html5'));
}
if (window.Uint8Array) {
  videojs.getComponent('Flash').registerSourceHandler(HlsSourceHandler('flash'));
}

videojs.HlsHandler = HlsHandler;
videojs.HlsSourceHandler = HlsSourceHandler;
videojs.Hls = Hls;
videojs.m3u8 = m3u8;

export default {
  Hls,
  HlsHandler,
  HlsSourceHandler
};
