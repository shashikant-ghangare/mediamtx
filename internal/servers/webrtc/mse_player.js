'use strict';

class MediaMTXMSEPlayer {
  /**
   * Creates an instance of MediaMTXMSEPlayer.
   * @param {HTMLVideoElement} videoElement - The HTML video element to play content in.
   * @param {string} manifestUrl - The URL of the HLS (.m3u8) manifest.
   * @param {string} initialCodecs - Codec string, e.g., "avc1.42E01E,mp4a.40.2".
   * @param {function(string): void} onErrorCallback - Callback for critical errors.
   */
  constructor(videoElement, manifestUrl, initialCodecs, onErrorCallback) {
    this.videoElement = videoElement;
    this.manifestUrl = manifestUrl;
    this.initialCodecs = initialCodecs;
    this.onErrorCallback = onErrorCallback || ((err) => console.error('MSEPlayer Error:', err));

    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectURL = null;

    this.initSegmentUrl = null;
    this.mediaSegmentUrls = [];
    this.currentSegmentIndex = 0;
    this.isFetching = false; // To prevent parallel fetches for now
    this.pendingSegments = []; // Queue for segments if sourceBuffer is busy

    this._boundOnSourceOpen = this._onSourceOpen.bind(this);
    this._boundOnUpdateEnd = this._onUpdateEnd.bind(this);
    this._boundOnError = this._onError.bind(this); // Generic error handler for MediaSource/SourceBuffer

    this.justAppendedInitSegment = false;
  }

  /**
   * Starts the player.
   */
  start() {
    if (this.mediaSource) {
      this.onErrorCallback('Player already started.');
      return;
    }

    console.log('MSEPlayer: Starting...');
    this.mediaSource = new MediaSource();
    this.mediaSource.addEventListener('sourceopen', this._boundOnSourceOpen);
    this.mediaSource.addEventListener('error', this._boundOnError);

    this.objectURL = URL.createObjectURL(this.mediaSource);
    this.videoElement.src = this.objectURL;
  }

  /**
   * Handles the 'sourceopen' event from MediaSource.
   * @private
   */
  _onSourceOpen() {
    console.log('MSEPlayer: MediaSource opened.');
    if (!this.mediaSource) return;

    try {
      const mimeType = `video/mp4; codecs="${this.initialCodecs}"`;
      if (!MediaSource.isTypeSupported(mimeType)) {
        this.onErrorCallback(`Unsupported MIME type or codecs: ${mimeType}`);
        this.destroy();
        return;
      }
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.addEventListener('updateend', this._boundOnUpdateEnd);
      this.sourceBuffer.addEventListener('error', this._boundOnError);
      console.log('MSEPlayer: SourceBuffer created.');

      this._fetchAndParseManifest();
    } catch (e) {
      this.onErrorCallback(`Error creating SourceBuffer: ${e.toString()}`);
      this.destroy();
    }
  }

  /**
   * Fetches and parses the HLS manifest.
   * @private
   */
  _fetchAndParseManifest() {
    console.log(`MSEPlayer: Fetching manifest from ${this.manifestUrl}`);
    this.isFetching = true;
    fetch(this.manifestUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Manifest fetch failed: ${response.status} ${response.statusText}`);
        }
        return response.text();
      })
      .then(manifestText => {
        this.isFetching = false;
        console.log('MSEPlayer: Manifest fetched.');
        this._parseManifest(manifestText);

        if (this.initSegmentUrl) {
          this._fetchAndAppendSegment(this.initSegmentUrl, true);
        } else {
          this.onErrorCallback('Initialization segment (EXT-X-MAP) not found in manifest.');
          this.destroy();
        }
      })
      .catch(error => {
        this.isFetching = false;
        this.onErrorCallback(`Error fetching or parsing manifest: ${error.toString()}`);
        this.destroy();
      });
  }

  /**
   * Parses the manifest text.
   * @param {string} manifestText
   * @private
   */
  _parseManifest(manifestText) {
    const lines = manifestText.split('\n');
    const baseUri = new URL(this.manifestUrl); // For resolving relative URLs

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('#EXT-X-MAP:')) {
        const uriMatch = trimmedLine.match(/URI="([^"]+)"/);
        if (uriMatch && uriMatch[1]) {
          this.initSegmentUrl = new URL(uriMatch[1], baseUri).href;
          console.log(`MSEPlayer: Found init segment: ${this.initSegmentUrl}`);
        }
      } else if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
        this.mediaSegmentUrls.push(new URL(trimmedLine, baseUri).href);
      }
    }
    console.log(`MSEPlayer: Found ${this.mediaSegmentUrls.length} media segments.`);
  }

  /**
   * Fetches a segment and appends it to the SourceBuffer.
   * @param {string} segmentUrl - The URL of the segment to fetch.
   * @param {boolean} isInitSegment - True if this is the initialization segment.
   * @private
   */
  _fetchAndAppendSegment(segmentUrl, isInitSegment) {
    if (!this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      console.warn(`MSEPlayer: Skipping fetch/append; SourceBuffer/MediaSource not ready. URL: ${segmentUrl}`);
      return;
    }

    if (this.sourceBuffer.updating || this.pendingSegments.length > 0) {
      console.log(`MSEPlayer: SourceBuffer busy or segments pending. Queuing ${segmentUrl}`);
      this.pendingSegments.push({ url: segmentUrl, isInit: isInitSegment });
      return;
    }
    
    console.log(`MSEPlayer: Fetching segment ${segmentUrl}`);
    this.isFetching = true;
    this.justAppendedInitSegment = isInitSegment; // Mark before fetch

    fetch(segmentUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Segment fetch failed: ${response.status} ${response.statusText} for ${segmentUrl}`);
        }
        return response.arrayBuffer();
      })
      .then(data => {
        this.isFetching = false;
        console.log(`MSEPlayer: Segment fetched (${(data.byteLength / 1024).toFixed(2)} KB). Appending to SourceBuffer.`);
        try {
          // The 'justAppendedInitSegment' flag is used in _onUpdateEnd.
          // It's better to set it here and check in _onUpdateEnd
          // to correctly sequence fetching media segments after init.
          this.sourceBuffer.appendBuffer(data);
        } catch (e) {
          if (e.name === 'QuotaExceededError') {
            this.onErrorCallback('QuotaExceededError while appending buffer. Consider implementing buffer eviction strategies.');
          } else {
            this.onErrorCallback(`Error appending buffer: ${e.toString()}`);
          }
          this.destroy();
        }
      })
      .catch(error => {
        this.isFetching = false;
        // If it's an init segment error, it's critical.
        if (isInitSegment) {
            this.onErrorCallback(`Error fetching init segment ${segmentUrl}: ${error.toString()}`);
            this.destroy();
        } else {
            // For media segments, we could try to skip or retry later. For now, report.
            this.onErrorCallback(`Error fetching media segment ${segmentUrl}: ${error.toString()}`);
            // Optionally, try to continue with the next segment or stop.
            // For this basic player, we'll stop on error.
            this.destroy();
        }
      });
  }

  /**
   * Handles the 'updateend' event from SourceBuffer.
   * @private
   */
  _onUpdateEnd() {
    if (!this.sourceBuffer || !this.mediaSource || this.mediaSource.readyState !== 'open') {
        console.warn('MSEPlayer: updateend called but SourceBuffer/MediaSource not ready or closed.');
        return;
    }
    console.log('MSEPlayer: SourceBuffer update ended.');

    if (this.pendingSegments.length > 0) {
      const nextSegment = this.pendingSegments.shift();
      console.log(`MSEPlayer: Processing queued segment: ${nextSegment.url}`);
      // Call _fetchAndAppendSegment, but it will immediately queue again if sourceBuffer.updating is true.
      // This should be fine as _onUpdateEnd will be called again.
      // The isFetching flag might need careful handling here if fetches are slow.
      // For simplicity, we assume fetch is quick enough or that the queue handles order.
      this._fetchAndAppendSegment(nextSegment.url, nextSegment.isInit);
      return; // Prioritize processing queue
    }
    
    if (this.justAppendedInitSegment) {
      this.justAppendedInitSegment = false; // Reset flag
      if (this.mediaSegmentUrls.length > 0) {
        console.log('MSEPlayer: Init segment processed. Fetching first media segment.');
        this._fetchAndAppendSegment(this.mediaSegmentUrls[this.currentSegmentIndex++], false);
      } else {
        console.log('MSEPlayer: Init segment processed, but no media segments found.');
        // If no media segments, and it's not a live stream (which we don't handle yet), we might be done.
        // this.mediaSource.endOfStream(); // Or handle as error if media segments were expected
      }
      return;
    }

    if (this.currentSegmentIndex < this.mediaSegmentUrls.length) {
      console.log(`MSEPlayer: Fetching next media segment ${this.currentSegmentIndex + 1}/${this.mediaSegmentUrls.length}`);
      this._fetchAndAppendSegment(this.mediaSegmentUrls[this.currentSegmentIndex++], false);
    } else {
      console.log('MSEPlayer: All media segments processed.');
      // For a static manifest, this is the end. For live, we would re-fetch manifest.
      if (this.mediaSource.readyState === 'open' && !this.sourceBuffer.updating) {
        try {
          this.mediaSource.endOfStream();
          console.log('MSEPlayer: MediaSource endOfStream called.');
        } catch (e) {
          this.onErrorCallback(`Error calling endOfStream: ${e.toString()}`);
        }
      }
    }
  }

  /**
   * Generic error handler for MediaSource and SourceBuffer.
   * @param {Event} event - The error event.
   * @private
   */
  _onError(event) {
    let errorMessage = 'MSEPlayer: Unknown error';
    if (event && event.target && event.target.error) {
      errorMessage = `MSEPlayer Error: ${event.target.error.code} - ${event.target.error.message}`;
    } else if (event && event.message) {
      errorMessage = `MSEPlayer Error: ${event.message}`;
    } else if (event && typeof event === 'string') {
      errorMessage = event;
    }
    this.onErrorCallback(errorMessage);
    this.destroy(); // Destroy on any MediaSource or SourceBuffer error
  }

  /**
   * Destroys the player and cleans up resources.
   */
  destroy() {
    console.log('MSEPlayer: Destroying...');
    if (this.mediaSource) {
      if (this.mediaSource.readyState === 'open' && this.sourceBuffer && !this.sourceBuffer.updating) {
        try {
          // Only call removeSourceBuffer if it was added and mediaSource is still open
          if (this.sourceBuffer) {
             // Before removing, unbind event listeners to prevent errors during cleanup
            this.sourceBuffer.removeEventListener('updateend', this._boundOnUpdateEnd);
            this.sourceBuffer.removeEventListener('error', this._boundOnError);
            if (this.mediaSource.sourceBuffers.length > 0) { // Check if sourceBuffer is still part of mediaSource
                this.mediaSource.removeSourceBuffer(this.sourceBuffer);
            }
          }
        } catch (e) {
          console.warn(`MSEPlayer: Error removing SourceBuffer: ${e.toString()}`);
        }
      }
      this.mediaSource.removeEventListener('sourceopen', this._boundOnSourceOpen);
      this.mediaSource.removeEventListener('error', this._boundOnError);
      
      // According to MDN, endOfStream should only be called if readyState is 'open'
      // and all buffers have finished updating.
      // However, if we are destroying due to an error, the state might be different.
      // It's safer to check conditions.
      if (this.mediaSource.readyState === 'open' && (!this.sourceBuffer || !this.sourceBuffer.updating)) {
          try {
            // Check if endOfStream was already called or is not appropriate
            if (this.mediaSource.sourceBuffers.length === 0) { // Or other conditions indicating it's safe/needed
                //this.mediaSource.endOfStream(); // This might cause issues if called prematurely or in wrong state.
            }
          } catch(e) {
            console.warn(`MSEPlayer: Error calling endOfStream during destroy: ${e.toString()}`);
          }
      }
    }

    if (this.objectURL) {
      URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
    }

    if (this.videoElement) {
        // Only clear src if it's our object URL.
        // It might have been changed by other logic (e.g. HLS fallback in reader.js)
        if (this.videoElement.src === this.objectURL) { 
            this.videoElement.removeAttribute('src');
            this.videoElement.load(); // Resets the media element
        }
    }
    
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.initSegmentUrl = null;
    this.mediaSegmentUrls = [];
    this.currentSegmentIndex = 0;
    this.pendingSegments = [];
    this.isFetching = false;
    console.log('MSEPlayer: Destroyed.');
  }
}

// Export if used as a module, or it will be available globally if included as a script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaMTXMSEPlayer;
} else {
  window.MediaMTXMSEPlayer = MediaMTXMSEPlayer;
}
