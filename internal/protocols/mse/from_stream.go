// Package mse contains MSE utilities.
package mse

import (
	"errors"
	"fmt"

	"github.com/bluenviron/gortsplib/v4/pkg/description"
	"github.com/bluenviron/gortsplib/v4/pkg/format"
	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/bluenviron/mediamtx/internal/stream"
	"github.com/bluenviron/mediamtx/internal/unit"
)

// ErrNoSupportedCodecs is returned by FromStream when there are no supported codecs.
var ErrNoSupportedCodecs = errors.New(
	"the stream doesn't contain any supported codec for MSE (fMP4)")

// Muxer is an MSE muxer.
type Muxer struct {
	// TODO: Define MSE muxer properties
}

// WriteFrame writes a frame to the Muxer.
func (m *Muxer) WriteFrame(trackID int, pts int64, frame []byte) error {
	// TODO: Implement frame writing logic for fMP4
	return nil
}

func setupVideoTrack(
	strea *stream.Stream,
	reader stream.Reader,
	muxer *Muxer,
	setuppedFormats map[format.Format]struct{},
) {
	addTrack := func(
		media *description.Media,
		forma format.Format,
		// TODO: Define MSE track representation
		readFunc stream.ReadFunc,
	) {
		// TODO: Add MSE track to muxer
		setuppedFormats[forma] = struct{}{}
		strea.AddReader(reader, media, forma, readFunc)
	}

	// Example for H264 - adapt for other codecs as needed
	var videoFormatH264 *format.H264
	videoMedia := strea.Desc.FindFormat(&videoFormatH264)

	if videoFormatH264 != nil {
		// TODO: Create MSE video track
		// sps, pps := videoFormatH264.SafeParams()

		addTrack(
			videoMedia,
			videoFormatH264,
			// TODO: Pass MSE video track
			func(u unit.Unit) error {
				tunit := u.(*unit.H264)

				if tunit.AU == nil {
					return nil
				}
				// TODO: Write H264 AU to fMP4 segment
				// err := muxer.WriteFrame(...)
				// if err != nil {
				// 	return fmt.Errorf("muxer error: %w", err)
				// }
				return nil
			})
		return
	}
}

func setupAudioTracks(
	strea *stream.Stream,
	reader stream.Reader,
	muxer *Muxer,
	setuppedFormats map[format.Format]struct{},
) {
	addTrack := func(
		medi *description.Media,
		forma format.Format,
		// TODO: Define MSE track representation
		readFunc stream.ReadFunc,
	) {
		// TODO: Add MSE track to muxer
		setuppedFormats[forma] = struct{}{}
		strea.AddReader(reader, medi, forma, readFunc)
	}

	for _, media := range strea.Desc.Medias {
		for _, forma := range media.Formats {
			switch forma := forma.(type) {
			case *format.MPEG4Audio:
				// TODO: Create MSE audio track
				// co := forma.GetConfig()
				// if co != nil {

				addTrack(
					media,
					forma,
					// TODO: Pass MSE audio track
					func(u unit.Unit) error {
						tunit := u.(*unit.MPEG4Audio)

						if tunit.AUs == nil {
							return nil
						}
						// TODO: Write MPEG4Audio AUs to fMP4 segment
						// err := muxer.WriteFrame(...)
						// if err != nil {
						// 	return fmt.Errorf("muxer error: %w", err)
						// }
						return nil
					})
				// }
			}
		}
	}
}

// FromStream maps a MediaMTX stream to an MSE muxer.
func FromStream(
	strea *stream.Stream,
	reader stream.Reader,
	muxer *Muxer,
) error {
	setuppedFormats := make(map[format.Format]struct{})

	setupVideoTrack(
		strea,
		reader,
		muxer,
		setuppedFormats,
	)

	setupAudioTracks(
		strea,
		reader,
		muxer,
		setuppedFormats,
	)

	// TODO: Check if any tracks were added
	// if len(muxer.Tracks) == 0 {
	// 	return ErrNoSupportedCodecs
	// }

	n := 1
	for _, media := range strea.Desc.Medias {
		for _, forma := range media.Formats {
			if _, ok := setuppedFormats[forma]; !ok {
				reader.Log(logger.Warn, "skipping track %d (%s) for MSE", n, forma.Codec())
			}
			n++
		}
	}

	return nil
}
