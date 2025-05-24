// reader.test.js

// Mocking a basic DOM environment for the tests if not using JSDOM from Jest
if (typeof window === 'undefined') {
  global.window = global;
  global.document = {
    getElementById: (id) => {
      if (id === 'remoteVideo' && global.videoElement) {
        return global.videoElement;
      }
      return null;
    },
    createElement: (type) => {
      if (type === 'video') {
        global.videoElement = {
          id: '',
          controls: false,
          autoplay: false,
          style: {},
          canPlayType: jest.fn(mimeType => mimeType === 'application/vnd.apple.mpegurl'),
          addEventListener: jest.fn(),
          play: jest.fn(() => Promise.resolve()),
          // Add other necessary video element properties and methods if needed by the SUT
        };
        return global.videoElement;
      }
      return {};
    },
    body: {
      appendChild: jest.fn(element => {
        if (element.tagName === 'VIDEO') { // Assuming video element would have a tagName
             global.videoElement = element; // Or handle more generically
        }
      }),
    },
  };
  global.URL = require('url').URL; // For URL parsing in reader.js
  global.RTCPeerConnection = jest.fn().mockImplementation(() => ({
    addTransceiver: jest.fn(),
    createOffer: jest.fn(() => Promise.resolve({ sdp: 'dummy-sdp', type: 'offer' })),
    setLocalDescription: jest.fn(() => Promise.resolve()),
    setRemoteDescription: jest.fn(() => Promise.resolve()),
    close: jest.fn(),
    onicecandidate: null,
    onconnectionstatechange: null,
    ontrack: null,
    connectionState: 'new',
    iceServers: [],
    sdpSemantics: '',
  }));
  global.RTCSessionDescription = jest.fn();
  global.fetch = jest.fn();
  global.setTimeout = jest.fn((fn, delay) => {
    // Store timeoutId to allow clearTimeout to be mocked/checked
    const timeoutId = `timeout_${Math.random().toString(36).substr(2, 9)}`;
    if (global.mockTimeouts) global.mockTimeouts[timeoutId] = fn;
    return timeoutId;
  });
  global.clearTimeout = jest.fn(timeoutId => {
    if (global.mockTimeouts && global.mockTimeouts[timeoutId]) {
      delete global.mockTimeouts[timeoutId];
    }
  });
  global.console = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// Load the MediaMTXWebRTCReader script.
// This might require adjusting the path or using a module loader depending on the actual test setup.
// For this example, let's assume it's already loaded and available as window.MediaMTXWebRTCReader
// If reader.js is a module, you'd use:
// const { MediaMTXWebRTCReader } = require('./reader');
// For now, we rely on it being on window.

describe('MediaMTXWebRTCReader HLS Fallback', () => {
  let reader;
  let mockOnError;
  let mockOnTrack;
  let videoElement;
  let originalFetch;
  let originalHls;
  let originalSupportsNonAdvertisedCodec;

  // Mock Hls.js
  const mockHlsInstance = {
    loadSource: jest.fn(),
    attachMedia: jest.fn(),
    on: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(() => {
    // Store original globals
    originalFetch = global.fetch;
    originalHls = window.Hls;
    
    // Mock HLS.js on window
    window.Hls = jest.fn(() => mockHlsInstance);
    window.Hls.isSupported = jest.fn(() => true);
    window.Hls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' }; // Mock events

    // Reset mocks for HLS instance methods
    mockHlsInstance.loadSource.mockReset();
    mockHlsInstance.attachMedia.mockReset();
    mockHlsInstance.on.mockReset();
    mockHlsInstance.destroy.mockReset();


    // Create and append video element to a mock body
    videoElement = document.createElement('video');
    videoElement.id = 'remoteVideo';
    document.body.appendChild(videoElement); // Mocked appendChild

    mockOnError = jest.fn();
    mockOnTrack = jest.fn();

    // Mock #getNonAdvertisedCodecs to simplify test setup
    // It calls #supportsNonAdvertisedCodec internally, which uses RTCPeerConnection
    // By mocking this, we avoid complex RTC mocks for the codec checking part
    originalSupportsNonAdvertisedCodec = window.MediaMTXWebRTCReader._supportsNonAdvertisedCodec;
    window.MediaMTXWebRTCReader._supportsNonAdvertisedCodec = jest.fn(() => Promise.resolve(false));
    
    global.mockTimeouts = {}; // For checking setTimeout calls

  });

  afterEach(() => {
    if (reader) {
      reader.close(); // Ensure any internal timers or connections are cleaned up
    }
    // Restore original globals
    global.fetch = originalFetch;
    window.Hls = originalHls;
    window.MediaMTXWebRTCReader._supportsNonAdvertisedCodec = originalSupportsNonAdvertisedCodec;

    // Clean up video element
    if (global.videoElement) {
        global.videoElement = null; // Remove from our mock DOM
    }
    // Clear any stray timeouts
    Object.values(global.mockTimeouts).forEach(fn => clearTimeout(fn)); // This is conceptual; actual clearing depends on setTimeout mock
    global.mockTimeouts = {};
    jest.clearAllMocks(); // Clears call counts etc. for jest.fn()
  });

  test("Switches to HLS on 'codecs not supported by client' error (using hls.js)", (done) => {
    const whepUrl = 'http://localhost:8889/teststream/whep';
    const expectedHlsUrl = 'http://localhost:8889/teststream/hls/teststream.m3u8';

    global.fetch = jest.fn((url, options) => {
      // Mock for #requestICEServers (OPTIONS)
      if (options && options.method === 'OPTIONS') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => '<stun:stun.l.google.com:19302>; rel="ice-server"' },
        });
      }
      // Mock for #sendOffer (POST to WHEP URL) - This is where we trigger the error
      if (options && options.method === 'POST' && url === whepUrl) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "codecs not supported by client" }),
          headers: { get: () => 'application/json' }, // Ensure headers are somewhat realistic
        });
      }
      // Mock for #getNonAdvertisedCodecs's internal fetch (if any, though we mock _supportsNonAdvertisedCodec)
      // Or DELETE for session cleanup (called in handleError)
      if (options && options.method === 'DELETE') {
          return Promise.resolve({ ok: true, status: 200 });
      }
      // Default fallback for any other fetch calls
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    });

    const conf = {
      url: whepUrl,
      onError: mockOnError,
      onTrack: mockOnTrack,
    };

    // Instantiation of MediaMTXWebRTCReader starts the process
    reader = new window.MediaMTXWebRTCReader(conf);

    // The error handling and HLS switch is asynchronous.
    // We need to wait for the promises to resolve and callbacks to be called.
    // A short timeout or observing mock calls can help.
    setTimeout(() => {
      try {
        expect(mockOnError).toHaveBeenCalled();
        // Check the *last* call to onError for the HLS switching message
        const lastErrorCallArgs = mockOnError.mock.calls[mockOnError.mock.calls.length - 1];
        expect(lastErrorCallArgs[0]).toBe("Codecs not supported by client, switching to HLS playback.");
        
        expect(window.Hls).toHaveBeenCalledTimes(1);
        expect(mockHlsInstance.loadSource).toHaveBeenCalledWith(expectedHlsUrl);
        expect(mockHlsInstance.attachMedia).toHaveBeenCalledWith(videoElement); // Check with the DOM element

        // Verify WebRTC restart logic was NOT triggered
        // Check that setTimeout was not called for restarting (this requires more specific setTimeout mocking)
        // For now, we can check reader.state and reader.restartTimeout
        expect(reader.state).toBe('failed'); // or 'hls_fallback' if we used that
        expect(reader.restartTimeout).toBeNull();
        
        done();
      } catch (e) {
        done(e);
      }
    }, 100); // Adjust timeout if necessary for async operations to complete
  });

  test("Switches to HLS on 'codecs not supported by client' error (native HLS)", (done) => {
    const whepUrl = 'http://localhost:8889/teststream2/whep';
    const expectedHlsUrl = 'http://localhost:8889/teststream2/hls/teststream2.m3u8';

    // Make HLS.js appear unsupported
    window.Hls.isSupported = jest.fn(() => false);

    global.fetch = jest.fn((url, options) => {
      if (options && options.method === 'OPTIONS') {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => '<stun:stun.l.google.com:19302>; rel="ice-server"' },
        });
      }
      if (options && options.method === 'POST' && url === whepUrl) {
        return Promise.resolve({
          ok: false, status: 400,
          json: () => Promise.resolve({ error: "codecs not supported by client" }),
          headers: { get: () => 'application/json' },
        });
      }
      if (options && options.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    });

    const conf = {
      url: whepUrl,
      onError: mockOnError,
      onTrack: mockOnTrack,
    };

    reader = new window.MediaMTXWebRTCReader(conf);

    setTimeout(() => {
      try {
        expect(mockOnError).toHaveBeenCalled();
        const lastErrorCallArgs = mockOnError.mock.calls[mockOnError.mock.calls.length - 1];
        expect(lastErrorCallArgs[0]).toBe("Codecs not supported by client, switching to HLS playback.");
        
        expect(window.Hls).not.toHaveBeenCalled(); // HLS constructor should not be called
        
        const currentVideoElement = document.getElementById('remoteVideo');
        expect(currentVideoElement.src).toBe(expectedHlsUrl);
        expect(currentVideoElement.type).toBe('application/vnd.apple.mpegurl');
        // Check if play was called on the video element
        expect(currentVideoElement.play).toHaveBeenCalled();


        expect(reader.state).toBe('failed');
        expect(reader.restartTimeout).toBeNull();
        
        done();
      } catch (e) {
        done(e);
      }
    }, 100);
  });
});

// Ensure MediaMTXWebRTCReader is loaded. This is a placeholder.
// In a real Jest setup, you would import it or ensure it's globally available via setupFiles.
// For now, we assume reader.js has been included and populated window.MediaMTXWebRTCReader.
// Example: require('./reader.js'); if it's made to be require-able.
// If reader.js is not a module, it would need to be loaded via a script tag in an HTML test runner,
// or pre-loaded into the Node global scope if using Jest for DOM-less JS testing.

// A simplified mock for RTCPeerConnection's static methods used in #getNonAdvertisedCodecs
// This is to make the #getNonAdvertisedCodecs part of the reader not fail before we get to #start
if (window.MediaMTXWebRTCReader) { // Check if reader.js was notionally "loaded"
    // This static method is called inside #getNonAdvertisedCodecs
    // We mock it here to prevent it from running its complex logic that involves actual PC objects
    window.MediaMTXWebRTCReader._supportsNonAdvertisedCodec = jest.fn(() => Promise.resolve(false));
} else {
    console.warn("window.MediaMTXWebRTCReader not found. Ensure reader.js is loaded before tests.");
    // Define a dummy so tests don't crash if reader.js isn't loaded.
    window.MediaMTXWebRTCReader = class {
        constructor() { this.close = jest.fn(); this.state = null; this.restartTimeout = null; }
        static _supportsNonAdvertisedCodec() { return Promise.resolve(false); }
    };
}

// Note: This test file structure assumes a Jest-like environment (describe, test, jest.fn, etc.)
// and that reader.js can somehow be loaded to make MediaMTXWebRTCReader available on `window`.
// The DOM mocking is basic; JSDOM (usually included with Jest) provides a more complete environment.
// The `setTimeout` for assertions is a common way to handle async code in tests, but modern Jest
// offers more robust ways like `async/await` with `waitFor` utilities if the methods under test
// return promises or can be awaited.
