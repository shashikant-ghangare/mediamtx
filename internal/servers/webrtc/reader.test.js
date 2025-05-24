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
          // MSE player doesn't rely on canPlayType for HLS mimetypes
          canPlayType: jest.fn(mimeType => {
            // Generic mock for video element's canPlayType
            if (mimeType === 'video/mp4; codecs="avc1.mock,mp4a.mock"') return 'probably';
            return '';
          }),
          addEventListener: jest.fn(),
          play: jest.fn(() => Promise.resolve()),
          load: jest.fn(), // Mock load method
          removeAttribute: jest.fn(), // Mock removeAttribute
        };
        return global.videoElement;
      }
      return {
        // Mock for other elements if any are created by SUT
      };
    },
    body: {
      appendChild: jest.fn(element => {
        // if (element.tagName === 'VIDEO') { // More robust check might be needed
        //   global.videoElement = element;
        // }
      }),
    },
  };
  global.URL = require('url').URL; 
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
  }));
  global.RTCSessionDescription = jest.fn();
  global.fetch = jest.fn();
  global.setTimeout = jest.fn((fn) => {
    const timeoutId = `timeout_${Math.random().toString(36).substr(2, 9)}`;
    // Simulating immediate execution for some tests or manual control via test runners
    // fn(); 
    return timeoutId;
  });
  global.clearTimeout = jest.fn();
  global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // Mock MediaMTXMSEPlayer
  global.MediaMTXMSEPlayer = jest.fn(() => ({
    start: jest.fn(),
    destroy: jest.fn(),
  }));
}


// Assuming reader.js is loaded and MediaMTXWebRTCReader is on window
// If reader.js is a module, use:
// const { MediaMTXWebRTCReader } = require('./reader'); 
// For now, we rely on it being on window.

describe('MediaMTXWebRTCReader MSE Fallback', () => {
  let reader;
  let mockOnError;
  let mockOnTrack;
  let videoElement;
  
  const mockMsePlayerInstance = {
    start: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks(); // Clear all mocks

    // Create and append video element to a mock body
    videoElement = global.document.createElement('video'); // Use the mocked createElement
    videoElement.id = 'remoteVideo';
    global.document.body.appendChild(videoElement); // Use the mocked appendChild

    mockOnError = jest.fn();
    mockOnTrack = jest.fn();

    // Mock MediaMTXMSEPlayer constructor and instance
    window.MediaMTXMSEPlayer = jest.fn(() => mockMsePlayerInstance);
    mockMsePlayerInstance.start.mockClear();
    mockMsePlayerInstance.destroy.mockClear();


    // Mock MediaMTXWebRTCReader's internal static method to simplify setup
    // This avoids needing to mock RTCPeerConnection's full codec negotiation
    if (window.MediaMTXWebRTCReader) {
        window.MediaMTXWebRTCReader._supportsNonAdvertisedCodec = jest.fn(() => Promise.resolve(false));
    } else {
        // Define a dummy if reader.js wasn't loaded for some reason (e.g. test environment issue)
        window.MediaMTXWebRTCReader = class { constructor() { this.close = jest.fn(); } static _supportsNonAdvertisedCodec() { return Promise.resolve(false); }};
        console.warn("window.MediaMTXWebRTCReader was not found, using dummy for tests.");
    }
    
    // Reset fetch mock for each test
    global.fetch = jest.fn();
  });

  afterEach(() => {
    if (reader) {
      reader.close(); 
    }
    if (global.videoElement) {
        // global.videoElement = null; // Not strictly necessary with jest.clearAllMocks if DOM is also virtual
    }
  });

  test("Switches to MSE on 'codecs not supported by client' error", async () => {
    const whepUrl = 'http://localhost:8889/teststream/whep';
    const expectedManifestUrl = 'http://localhost:8889/teststream/hls/teststream.m3u8';
    const mockCodecs = "avc1.mock,mp4a.mock";
    const mockManifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="${mockCodecs}"\nsegment1.ts`;

    // Setup fetch mock
    global.fetch
      // 1. Mock for #requestICEServers (OPTIONS)
      .mockImplementationOnce((url, options) => {
        if (options && options.method === 'OPTIONS') {
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => '<stun:stun.l.google.com:19302>; rel="ice-server"' },
          });
        }
        // Fallback for unexpected calls during this phase
        return Promise.reject(new Error(`Unexpected fetch call to ${url} with options ${JSON.stringify(options)} during ICE server request`));
      })
      // 2. Mock for #sendOffer (POST to WHEP URL) - This triggers the error
      .mockImplementationOnce((url, options) => {
        if (options && options.method === 'POST' && url === whepUrl) {
          return Promise.resolve({
            ok: false, status: 400,
            json: () => Promise.resolve({ error: "codecs not supported by client" }),
            // headers: { get: () => 'application/json' }, // Not strictly needed for the error path
          });
        }
        return Promise.reject(new Error(`Unexpected fetch call to ${url} with options ${JSON.stringify(options)} during WHEP POST`));
      })
      // 3. Mock for #fetchCodecsFromManifest (GET the manifest)
      .mockImplementationOnce((url, options) => {
        if (url === expectedManifestUrl && (!options || options.method === 'GET' || options.method === undefined)) {
          return Promise.resolve({
            ok: true, status: 200,
            text: () => Promise.resolve(mockManifest),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch call to ${url} with options ${JSON.stringify(options)} during manifest fetch`));
      })
      // 4. Mock for DELETE session call in WebRTC cleanup
      .mockImplementationOnce((url, options) => {
         if (options && options.method === 'DELETE' && url.startsWith(whepUrl)) { // session URL might be slightly different
             return Promise.resolve({ ok: true, status: 204 });
         }
         return Promise.reject(new Error(`Unexpected fetch call to ${url} with options ${JSON.stringify(options)} during session delete`));
      });


    const conf = {
      url: whepUrl,
      onError: mockOnError,
      onTrack: mockOnTrack,
    };

    reader = new window.MediaMTXWebRTCReader(conf);

    // Wait for async operations to complete. Jest's fake timers or more robust async handling might be better.
    // For now, a simple promise flush or short delay.
    await new Promise(resolve => setTimeout(resolve, 100)); // Let async chain in reader proceed

    // Assertions
    expect(global.fetch).toHaveBeenCalledWith(expectedManifestUrl, undefined); // Check manifest fetch
    
    expect(window.MediaMTXMSEPlayer).toHaveBeenCalledTimes(1);
    expect(window.MediaMTXMSEPlayer).toHaveBeenCalledWith(
      videoElement, // Ensure the global.videoElement is what's passed if created by mock document
      expectedManifestUrl,
      mockCodecs,
      expect.any(Function) // The MSE player's error callback
    );

    expect(mockMsePlayerInstance.start).toHaveBeenCalledTimes(1);
    
    // Check the *last* call to onError for the MSE switching message
    // It might be called multiple times (e.g. initial error, then MSE switch info)
    const lastErrorCall = mockOnError.mock.calls.pop();
    expect(lastErrorCall[0]).toBe("Codecs not supported by client, switching to MSE playback.");
    
    expect(reader.state).toBe('failed'); // Or a specific state like 'mse_fallback'
    expect(reader.restartTimeout).toBeNull(); // WebRTC restart should not be scheduled
    expect(reader.pc).toBeNull(); // PeerConnection should be cleaned up
  });

  test("close() method destroys MSE player if active", async () => {
    const whepUrl = 'http://localhost:8889/teststream_close/whep';
    const expectedManifestUrl = 'http://localhost:8889/teststream_close/hls/teststream_close.m3u8';
    const mockCodecs = "avc1.close,mp4a.close";
    const mockManifest = `#EXTM3U\n#EXT-X-STREAM-INF:CODECS="${mockCodecs}"\nsegment.ts`;

    global.fetch
      .mockResolvedValueOnce({ // OPTIONS
        ok: true, status: 200, headers: { get: () => '' }
      })
      .mockResolvedValueOnce({ // POST WHEP - error
        ok: false, status: 400, json: () => Promise.resolve({ error: "codecs not supported by client" })
      })
      .mockResolvedValueOnce({ // GET Manifest
        ok: true, status: 200, text: () => Promise.resolve(mockManifest)
      })
      .mockResolvedValueOnce({ // DELETE session
        ok: true, status: 204
      });

    const conf = { url: whepUrl, onError: mockOnError };
    reader = new window.MediaMTXWebRTCReader(conf);

    await new Promise(resolve => setTimeout(resolve, 50)); // Allow MSE player to be created

    expect(window.MediaMTXMSEPlayer).toHaveBeenCalledTimes(1); // MSE player should have been created
    
    reader.close(); // Call the close method

    expect(mockMsePlayerInstance.destroy).toHaveBeenCalledTimes(1);
    expect(reader.msePlayer).toBeNull(); // Should be nulled out
  });

});

// Ensure MediaMTXWebRTCReader and MediaMTXMSEPlayer are loaded/mocked for tests.
// This is a simplified setup. In a real Jest environment, use setupFiles or module imports.
if (!window.MediaMTXWebRTCReader) {
    window.MediaMTXWebRTCReader = class { 
        constructor(conf) { this.conf = conf; this.close = jest.fn(); this.state = null; this.pc = null; this.restartTimeout = null;} 
        static _supportsNonAdvertisedCodec() { return Promise.resolve(false); }
        // Add a mock for #fetchCodecsFromManifest if it's called directly in tests (it's private)
    };
}
if (!window.MediaMTXMSEPlayer) {
    window.MediaMTXMSEPlayer = jest.fn(() => ({
        start: jest.fn(),
        destroy: jest.fn(),
    }));
}
