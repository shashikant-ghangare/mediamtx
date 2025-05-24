// mse_player.test.js

// Basic DOM and Global Mocks
if (typeof window === 'undefined') {
  global.window = global;
  global.document = {
    getElementById: jest.fn(),
    createElement: jest.fn(() => ({
      id: '',
      controls: false,
      autoplay: false,
      style: {},
      src: '',
      load: jest.fn(),
      removeAttribute: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
    body: { appendChild: jest.fn() },
  };
  global.URL = {
    createObjectURL: jest.fn(() => 'blob:http://localhost/mock-object-url'),
    revokeObjectURL: jest.fn(),
  };
  global.fetch = jest.fn();
  global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // Mock MediaSource and SourceBuffer
  global.MediaSource = jest.fn(() => ({
    readyState: 'closed',
    addSourceBuffer: jest.fn(),
    removeSourceBuffer: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    endOfStream: jest.fn(),
    sourceBuffers: [], // Mock this as an array
  }));
  // SourceBuffer mock will be more dynamic in tests
}

// Assuming mse_player.js is loaded and MediaMTXMSEPlayer is on window
// Or use: const { MediaMTXMSEPlayer } = require('./mse_player');

describe('MediaMTXMSEPlayer', () => {
  let player;
  let mockVideoElement;
  let mockOnErrorCallback;
  let mockMediaSourceInstance;
  let mockSourceBufferInstance;

  const manifestUrl = 'http://localhost/test.m3u8';
  const initialCodecs = 'avc1.mock,mp4a.mock';

  beforeEach(() => {
    jest.clearAllMocks();

    mockVideoElement = document.createElement('video');
    mockOnErrorCallback = jest.fn();

    mockSourceBufferInstance = {
      appendBuffer: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      updating: false,
      // abort: jest.fn(), // If needed
    };

    mockMediaSourceInstance = {
      readyState: 'closed', // Initial state
      addSourceBuffer: jest.fn(() => mockSourceBufferInstance),
      removeSourceBuffer: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      endOfStream: jest.fn(),
      sourceBuffers: [mockSourceBufferInstance], // Mock, can be empty initially
    };
    window.MediaSource = jest.fn(() => mockMediaSourceInstance);
    window.MediaSource.isTypeSupported = jest.fn(() => true); // Assume type is supported

    // Reset fetch for each test
    global.fetch = jest.fn();

    player = new window.MediaMTXMSEPlayer(
      mockVideoElement,
      manifestUrl,
      initialCodecs,
      mockOnErrorCallback
    );
  });

  afterEach(() => {
    if (player) {
      player.destroy(); // Ensure cleanup for each test
    }
  });

  test('Initialization and start() call', () => {
    player.start();

    expect(window.MediaSource).toHaveBeenCalledTimes(1);
    expect(mockVideoElement.src).toBe('blob:http://localhost/mock-object-url');
    expect(window.URL.createObjectURL).toHaveBeenCalledWith(mockMediaSourceInstance);
    expect(mockMediaSourceInstance.addEventListener).toHaveBeenCalledWith('sourceopen', player._boundOnSourceOpen);
    expect(mockMediaSourceInstance.addEventListener).toHaveBeenCalledWith('error', player._boundOnError);

    // Simulate 'sourceopen'
    // Find the 'sourceopen' callback and call it
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(
      call => call[0] === 'sourceopen'
    )[1];
    
    mockMediaSourceInstance.readyState = 'open'; // Simulate state change
    sourceOpenCallback(); // Trigger sourceopen

    expect(mockMediaSourceInstance.addSourceBuffer).toHaveBeenCalledWith(`video/mp4; codecs="${initialCodecs}"`);
    expect(mockSourceBufferInstance.addEventListener).toHaveBeenCalledWith('updateend', player._boundOnUpdateEnd);
    expect(mockSourceBufferInstance.addEventListener).toHaveBeenCalledWith('error', player._boundOnError);
    expect(global.fetch).toHaveBeenCalledWith(manifestUrl); // fetch for manifest
  });
  
  test('Manifest parsing for init and media segments', async () => {
    const mockManifestText = 
      '#EXTM3U\n' +
      '#EXT-X-MAP:URI="init.mp4"\n' +
      'segment1.ts\n' +
      'segment2.ts';
    const baseUri = new URL(manifestUrl);
    const expectedInitUrl = new URL("init.mp4", baseUri).href;
    const expectedSegment1Url = new URL("segment1.ts", baseUri).href;

    global.fetch.mockResolvedValueOnce({ // Manifest fetch
      ok: true,
      text: () => Promise.resolve(mockManifestText),
    });
    global.fetch.mockResolvedValueOnce({ // Init segment fetch
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });


    player.start();
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open';
    sourceOpenCallback();

    await new Promise(resolve => setTimeout(resolve, 0)); // Allow promises to resolve

    expect(player.initSegmentUrl).toBe(expectedInitUrl);
    expect(player.mediaSegmentUrls).toEqual([
      expectedSegment1Url,
      new URL("segment2.ts", baseUri).href,
    ]);
    expect(global.fetch).toHaveBeenCalledWith(expectedInitUrl); // Fetch for init segment
    expect(mockSourceBufferInstance.appendBuffer).toHaveBeenCalledTimes(1); // For init segment
  });

  test('Segment fetching and appending, then next segment on updateend', async () => {
    const mockManifestText = 
      '#EXTM3U\n' +
      '#EXT-X-MAP:URI="init.mp4"\n' +
      'segment1.ts\n' +
      'segment2.ts';
    const initSegmentData = new ArrayBuffer(10);
    const mediaSegment1Data = new ArrayBuffer(20);
    const mediaSegment2Data = new ArrayBuffer(22);

    global.fetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockManifestText) }) // Manifest
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(initSegmentData) }) // Init segment
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(mediaSegment1Data) }) // Media segment 1
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(mediaSegment2Data) }); // Media segment 2

    player.start();
    // Simulate sourceopen
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open';
    sourceOpenCallback();
    
    await new Promise(resolve => setTimeout(resolve, 0)); // Manifest fetch and init segment fetch
    expect(mockSourceBufferInstance.appendBuffer).toHaveBeenCalledWith(initSegmentData);

    // Simulate updateend after init segment
    player.justAppendedInitSegment = true; // Manually ensure this was set before updateend
    const updateEndCallback = mockSourceBufferInstance.addEventListener.mock.calls.find(call => call[0] === 'updateend')[1];
    updateEndCallback();
    await new Promise(resolve => setTimeout(resolve, 0)); // Media segment 1 fetch
    expect(mockSourceBufferInstance.appendBuffer).toHaveBeenCalledWith(mediaSegment1Data);

    // Simulate updateend after media segment 1
    player.justAppendedInitSegment = false;
    updateEndCallback();
    await new Promise(resolve => setTimeout(resolve, 0)); // Media segment 2 fetch
    expect(mockSourceBufferInstance.appendBuffer).toHaveBeenCalledWith(mediaSegment2Data);
    
    // Simulate updateend after media segment 2 (last segment)
    updateEndCallback();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockMediaSourceInstance.endOfStream).toHaveBeenCalled();
  });

  test('Error handling: manifest fetch error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network Failure')); // Manifest fetch fails

    player.start();
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open';
    sourceOpenCallback();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockOnErrorCallback).toHaveBeenCalledWith(expect.stringContaining('Error fetching or parsing manifest: Error: Network Failure'));
    expect(mockVideoElement.removeAttribute).toHaveBeenCalledWith('src'); // Check destroy path
  });

   test('Error handling: init segment fetch error', async () => {
    const mockManifestText = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment1.ts';
    global.fetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockManifestText) }) // Manifest
        .mockRejectedValueOnce(new Error('Init Segment Fail')); // Init segment fetch fails

    player.start();
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open';
    sourceOpenCallback();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockOnErrorCallback).toHaveBeenCalledWith(expect.stringContaining('Error fetching init segment'));
    expect(mockVideoElement.removeAttribute).toHaveBeenCalledWith('src');
  });

  test('Error handling: SourceBuffer error event', () => {
    player.start();
    // Simulate sourceopen and sourcebuffer creation
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open';
    sourceOpenCallback();
    
    // Simulate error on sourceBuffer
    const errorCallback = mockSourceBufferInstance.addEventListener.mock.calls.find(call => call[0] === 'error')[1];
    const mockErrorEvent = { target: { error: { code: 123, message: "SB Error" } } };
    errorCallback(mockErrorEvent);

    expect(mockOnErrorCallback).toHaveBeenCalledWith(expect.stringContaining('MSEPlayer Error: 123 - SB Error'));
    expect(player.mediaSource).toBeNull(); // Destroyed
  });
  
  test('destroy() method cleans up resources', () => {
    player.start(); // Initialize some resources
    const sourceOpenCallback = mockMediaSourceInstance.addEventListener.mock.calls.find(call => call[0] === 'sourceopen')[1];
    mockMediaSourceInstance.readyState = 'open'; // Need to be open to attempt removeSourceBuffer
    sourceOpenCallback(); // This will add sourceBuffer to mediaSource.sourceBuffers for the mock

    player.destroy();

    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/mock-object-url');
    expect(mockVideoElement.removeAttribute).toHaveBeenCalledWith('src');
    expect(mockVideoElement.load).toHaveBeenCalled();
    
    // Check listeners removed
    expect(mockMediaSourceInstance.removeEventListener).toHaveBeenCalledWith('sourceopen', player._boundOnSourceOpen);
    expect(mockMediaSourceInstance.removeEventListener).toHaveBeenCalledWith('error', player._boundOnError);
    if (player.sourceBuffer) { // It should be null after destroy, checking instance used before nullification
        // This check is tricky because player.sourceBuffer is nulled.
        // We rely on mockSourceBufferInstance to check if its removeEventListener was called
    }
    expect(mockSourceBufferInstance.removeEventListener).toHaveBeenCalledWith('updateend', player._boundOnUpdateEnd);
    expect(mockSourceBufferInstance.removeEventListener).toHaveBeenCalledWith('error', player._boundOnError);

    // Check if removeSourceBuffer was attempted (if conditions met)
    // In this mock, mediaSource.sourceBuffers has the mockSourceBufferInstance
    expect(mockMediaSourceInstance.removeSourceBuffer).toHaveBeenCalledWith(mockSourceBufferInstance);


    expect(player.mediaSource).toBeNull();
    expect(player.sourceBuffer).toBeNull();
    expect(player.objectURL).toBeNull();
  });
});

// Ensure MediaMTXMSEPlayer is loaded.
// If it's a module, use: require('./mse_player.js');
// For this environment, assume it's on window.MediaMTXMSEPlayer
if (!window.MediaMTXMSEPlayer) {
    // Fallback if not loaded by test runner or setup script
    window.MediaMTXMSEPlayer = class {
        constructor(videoElement, manifestUrl, initialCodecs, onErrorCallback) {
            this._boundOnSourceOpen = jest.fn();
            this._boundOnUpdateEnd = jest.fn();
            this._boundOnError = jest.fn();
            this.destroy = jest.fn();
            this.start = jest.fn();
        }
    };
}
