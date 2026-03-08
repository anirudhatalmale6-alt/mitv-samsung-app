/**
 * MI TV - Samsung Tizen Smart TV App
 * 24/7 Spanish Entertainment Channel
 *
 * Uses AVPlay API for HLS live streaming
 * Handles Samsung remote control, multitasking, network changes
 */

(function () {
    'use strict';

    // ── Configuration ──
    var STREAM_URL = 'https://mitv.getstreamhosting.com:1936/live/live/playlist.m3u8';
    var OSD_TIMEOUT = 5000;       // Hide OSD after 5 seconds
    var RETRY_DELAY = 5000;       // Retry stream after 5 seconds
    var MAX_RETRIES = 5;          // Maximum auto-retry attempts

    // ── Key Codes ──
    var KEY = {
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        ENTER: 13,
        BACK: 10009,
        EXIT: 10182,
        PLAY_PAUSE: 10252,
        PLAY: 415,
        PAUSE: 19,
        STOP: 413,
        RED: 403,
        GREEN: 404,
        YELLOW: 405,
        BLUE: 406
    };

    // ── State ──
    var state = {
        isPlaying: false,
        isPaused: false,
        isBuffering: false,
        isLoading: true,
        osdVisible: false,
        exitPopupVisible: false,
        errorPopupVisible: false,
        exitFocusIndex: 0,       // 0 = No, 1 = Yes
        errorFocusIndex: 0,      // 0 = Retry, 1 = Exit
        osdTimer: null,
        retryCount: 0,
        networkAvailable: true
    };

    // ── DOM Elements ──
    var els = {};

    // ── Initialize ──
    function init() {
        cacheElements();
        registerKeys();
        bindEvents();
        updateClock();
        setInterval(updateClock, 30000);

        // Start playback after a brief delay for UI to render
        setTimeout(function () {
            startPlayback();
        }, 500);
    }

    function cacheElements() {
        els.loadingScreen = document.getElementById('loading-screen');
        els.topBar = document.getElementById('top-bar');
        els.bottomBar = document.getElementById('bottom-bar');
        els.bufferingOverlay = document.getElementById('buffering-overlay');
        els.bufferingPercent = document.getElementById('buffering-percent');
        els.pauseIndicator = document.getElementById('pause-indicator');
        els.errorPopup = document.getElementById('error-popup');
        els.errorTitle = document.getElementById('error-title');
        els.errorMessage = document.getElementById('error-message');
        els.exitPopup = document.getElementById('exit-popup');
        els.btnRetry = document.getElementById('btn-retry');
        els.btnExitError = document.getElementById('btn-exit-error');
        els.btnNo = document.getElementById('btn-no');
        els.btnYes = document.getElementById('btn-yes');
        els.clock = document.getElementById('clock');
    }

    // ── Register Remote Keys ──
    function registerKeys() {
        try {
            var keysToRegister = [
                'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'
            ];
            tizen.tvinputdevice.registerKeyBatch(
                keysToRegister,
                function () { console.log('[MITV] Keys registered'); },
                function (err) { console.error('[MITV] Key registration failed:', err.message); }
            );
        } catch (e) {
            console.warn('[MITV] Key registration not available (emulator?):', e.message);
        }
    }

    // ── Event Binding ──
    function bindEvents() {
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // ── Clock ──
    function updateClock() {
        var now = new Date();
        var h = now.getHours();
        var m = now.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        m = m < 10 ? '0' + m : m;
        els.clock.textContent = h + ':' + m + ' ' + ampm;
    }

    // ── AVPlay Streaming ──
    function startPlayback() {
        console.log('[MITV] Starting playback: ' + STREAM_URL);

        try {
            webapis.avplay.open(STREAM_URL);

            webapis.avplay.setListener({
                onbufferingstart: function () {
                    console.log('[MITV] Buffering started');
                    state.isBuffering = true;
                    showBuffering();
                },
                onbufferingprogress: function (percent) {
                    els.bufferingPercent.textContent = percent + '%';
                },
                onbufferingcomplete: function () {
                    console.log('[MITV] Buffering complete');
                    state.isBuffering = false;
                    hideBuffering();
                    hideLoadingScreen();
                    state.retryCount = 0; // Reset retry counter on successful buffer
                },
                oncurrentplaytime: function () {
                    // Live stream - no progress tracking needed
                },
                onstreamcompleted: function () {
                    console.log('[MITV] Stream completed');
                    handleStreamEnd();
                },
                onevent: function (eventType, eventData) {
                    console.log('[MITV] Event:', eventType, eventData);
                },
                onerror: function (eventType) {
                    console.error('[MITV] Playback error:', eventType);
                    handlePlaybackError(eventType);
                },
                onsubtitlechange: function () {},
                ondrmevent: function () {}
            });

            webapis.avplay.setDisplayRect(0, 0, 1920, 1080);

            // Optimize for live HLS
            webapis.avplay.setStreamingProperty('ADAPTIVE_INFO',
                'STARTBITRATE=HIGHEST|SKIPBITRATE=LOWEST'
            );

            webapis.avplay.prepareAsync(
                function () {
                    console.log('[MITV] Prepared successfully');
                    webapis.avplay.play();
                    state.isPlaying = true;
                    state.isPaused = false;

                    // Show OSD briefly on start
                    showOSD();
                },
                function () {
                    console.error('[MITV] Prepare failed');
                    handlePlaybackError('PREPARE_FAILED');
                }
            );

        } catch (e) {
            console.error('[MITV] AVPlay exception:', e.message);
            handlePlaybackError(e.message);
        }
    }

    function stopPlayback() {
        try {
            var playerState = webapis.avplay.getState();
            if (playerState !== 'NONE' && playerState !== 'IDLE') {
                webapis.avplay.stop();
            }
            webapis.avplay.close();
        } catch (e) {
            console.warn('[MITV] Stop error:', e.message);
        }
        state.isPlaying = false;
        state.isPaused = false;
    }

    function togglePlayPause() {
        try {
            var playerState = webapis.avplay.getState();
            if (playerState === 'PLAYING') {
                webapis.avplay.pause();
                state.isPaused = true;
                state.isPlaying = false;
                showPauseIndicator();
                showOSD();
            } else if (playerState === 'PAUSED') {
                webapis.avplay.play();
                state.isPaused = false;
                state.isPlaying = true;
                hidePauseIndicator();
                showOSD();
            } else if (playerState === 'IDLE' || playerState === 'NONE') {
                // Restart playback
                startPlayback();
            }
        } catch (e) {
            console.error('[MITV] Toggle play/pause error:', e.message);
        }
    }

    // ── Error / Retry Handling ──
    function handlePlaybackError(errorType) {
        state.isPlaying = false;
        hideBuffering();
        hideLoadingScreen();

        if (state.retryCount < MAX_RETRIES) {
            state.retryCount++;
            console.log('[MITV] Retry attempt ' + state.retryCount + '/' + MAX_RETRIES);
            showBufferingWithMessage('Reconnecting... (attempt ' + state.retryCount + ')');

            setTimeout(function () {
                try { stopPlayback(); } catch (e) {}
                startPlayback();
            }, RETRY_DELAY);
        } else {
            showErrorPopup(
                'Stream Unavailable',
                'Unable to connect to the live stream. Please check your internet connection or try again later.'
            );
        }
    }

    function handleStreamEnd() {
        // For a 24/7 stream, this likely means a temporary interruption
        state.retryCount = 0;
        handlePlaybackError('STREAM_ENDED');
    }

    // ── UI State Management ──
    function hideLoadingScreen() {
        els.loadingScreen.classList.add('hidden');
        setTimeout(function () {
            els.loadingScreen.style.display = 'none';
        }, 800);
    }

    function showBuffering() {
        els.bufferingPercent.textContent = '';
        els.bufferingOverlay.classList.add('active');
    }

    function showBufferingWithMessage(msg) {
        els.bufferingOverlay.querySelector('.buffering-text').textContent = msg;
        els.bufferingPercent.textContent = '';
        els.bufferingOverlay.classList.add('active');
    }

    function hideBuffering() {
        els.bufferingOverlay.classList.remove('active');
        els.bufferingOverlay.querySelector('.buffering-text').textContent = 'Buffering...';
    }

    function showPauseIndicator() {
        els.pauseIndicator.classList.add('active');
    }

    function hidePauseIndicator() {
        els.pauseIndicator.classList.remove('active');
    }

    function showOSD() {
        els.topBar.classList.add('visible');
        els.bottomBar.classList.add('visible');
        state.osdVisible = true;

        clearTimeout(state.osdTimer);
        state.osdTimer = setTimeout(function () {
            hideOSD();
        }, OSD_TIMEOUT);
    }

    function hideOSD() {
        if (!state.isPaused) {
            els.topBar.classList.remove('visible');
            els.bottomBar.classList.remove('visible');
            state.osdVisible = false;
        }
    }

    // ── Exit Popup ──
    function showExitPopup() {
        state.exitPopupVisible = true;
        state.exitFocusIndex = 0; // Default to "No"
        els.exitPopup.classList.add('active');
        updateExitFocus();
    }

    function hideExitPopup() {
        state.exitPopupVisible = false;
        els.exitPopup.classList.remove('active');
    }

    function updateExitFocus() {
        els.btnNo.classList.toggle('focused', state.exitFocusIndex === 0);
        els.btnYes.classList.toggle('focused', state.exitFocusIndex === 1);
    }

    // ── Error Popup ──
    function showErrorPopup(title, message) {
        state.errorPopupVisible = true;
        state.errorFocusIndex = 0; // Default to "Retry"
        els.errorTitle.textContent = title;
        els.errorMessage.textContent = message;
        els.errorPopup.classList.add('active');
        updateErrorFocus();
    }

    function hideErrorPopup() {
        state.errorPopupVisible = false;
        els.errorPopup.classList.remove('active');
    }

    function updateErrorFocus() {
        els.btnRetry.classList.toggle('focused', state.errorFocusIndex === 0);
        els.btnExitError.classList.toggle('focused', state.errorFocusIndex === 1);
    }

    // ── Keyboard / Remote Handler ──
    function onKeyDown(event) {
        var keyCode = event.keyCode;
        console.log('[MITV] Key pressed:', keyCode);

        // EXIT key: always exit immediately (Samsung certification requirement)
        if (keyCode === KEY.EXIT) {
            exitApp();
            return;
        }

        // Handle popups first
        if (state.exitPopupVisible) {
            handleExitPopupKey(keyCode);
            return;
        }

        if (state.errorPopupVisible) {
            handleErrorPopupKey(keyCode);
            return;
        }

        // Normal mode key handling
        switch (keyCode) {
            case KEY.BACK:
                showExitPopup();
                break;

            case KEY.ENTER:
            case KEY.PLAY_PAUSE:
                togglePlayPause();
                break;

            case KEY.PLAY:
                if (state.isPaused) {
                    togglePlayPause();
                }
                break;

            case KEY.PAUSE:
                if (state.isPlaying) {
                    togglePlayPause();
                }
                break;

            case KEY.STOP:
                stopPlayback();
                showExitPopup();
                break;

            case KEY.UP:
            case KEY.DOWN:
            case KEY.LEFT:
            case KEY.RIGHT:
                // Show OSD on any navigation key
                showOSD();
                break;

            case KEY.RED:
                // Could be used for future features (e.g., channel info)
                showOSD();
                break;

            default:
                break;
        }

        event.preventDefault();
    }

    function handleExitPopupKey(keyCode) {
        switch (keyCode) {
            case KEY.LEFT:
            case KEY.RIGHT:
                state.exitFocusIndex = state.exitFocusIndex === 0 ? 1 : 0;
                updateExitFocus();
                break;

            case KEY.ENTER:
                if (state.exitFocusIndex === 1) {
                    // "Yes" - exit
                    exitApp();
                } else {
                    // "No" - dismiss
                    hideExitPopup();
                }
                break;

            case KEY.BACK:
                hideExitPopup();
                break;
        }
    }

    function handleErrorPopupKey(keyCode) {
        switch (keyCode) {
            case KEY.LEFT:
            case KEY.RIGHT:
                state.errorFocusIndex = state.errorFocusIndex === 0 ? 1 : 0;
                updateErrorFocus();
                break;

            case KEY.ENTER:
                if (state.errorFocusIndex === 0) {
                    // "Retry"
                    hideErrorPopup();
                    state.retryCount = 0;
                    showBufferingWithMessage('Reconnecting...');
                    try { stopPlayback(); } catch (e) {}
                    startPlayback();
                } else {
                    // "Exit"
                    exitApp();
                }
                break;

            case KEY.BACK:
                hideErrorPopup();
                break;
        }
    }

    // ── Multitasking (Samsung certification requirement) ──
    function onVisibilityChange() {
        if (document.hidden) {
            console.log('[MITV] App hidden - suspending playback');
            try {
                var playerState = webapis.avplay.getState();
                if (playerState === 'PLAYING' || playerState === 'PAUSED') {
                    webapis.avplay.suspend();
                }
            } catch (e) {
                console.warn('[MITV] Suspend error:', e.message);
            }
        } else {
            console.log('[MITV] App resumed - restoring playback');
            try {
                webapis.avplay.restore();
            } catch (e) {
                console.warn('[MITV] Restore failed, restarting:', e.message);
                // If restore fails, restart from scratch
                try { stopPlayback(); } catch (e2) {}
                state.retryCount = 0;
                startPlayback();
            }
        }
    }

    // ── Exit ──
    function exitApp() {
        console.log('[MITV] Exiting app');
        try {
            stopPlayback();
        } catch (e) {}
        try {
            tizen.application.getCurrentApplication().exit();
        } catch (e) {
            console.error('[MITV] Exit failed:', e.message);
        }
    }

    // ── Start app when DOM is ready ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
