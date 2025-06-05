// Package mse contains a MSE server.
package mse

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"sync"

	"github.com/gin-gonic/gin"

	"github.com/bluenviron/mediamtx/internal/conf"
	"github.com/bluenviron/mediamtx/internal/defs"
	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/bluenviron/mediamtx/internal/protocols/httpp"
	mseprotocol "github.com/bluenviron/mediamtx/internal/protocols/mse"
	"github.com/bluenviron/mediamtx/internal/stream"
)

// ErrMuxerNotFound is returned when a muxer is not found.
var ErrMuxerNotFound = errors.New("muxer not found")

func interfaceIsEmpty(i interface{}) bool {
	return reflect.ValueOf(i).Kind() != reflect.Ptr || reflect.ValueOf(i).IsNil()
}

type serverGetMuxerRes struct {
	muxer *muxer
	err   error
}

type serverGetMuxerReq struct {
	path           string
	remoteAddr     string
	query          string
	sourceOnDemand bool
	res            chan serverGetMuxerRes
}

type serverAPIMuxersListRes struct {
	data *defs.APIMSEMuxerList // TODO: Define this in defs
	err  error
}

type serverAPIMuxersListReq struct {
	res chan serverAPIMuxersListRes
}

type serverAPIMuxersGetRes struct {
	data *defs.APIMSEMuxer // TODO: Define this in defs
	err  error
}

type serverAPIMuxersGetReq struct {
	name string
	res  chan serverAPIMuxersGetRes
}

type serverMetrics interface {
	SetMSEServer(defs.APIMSEServer) // TODO: Define this in defs
}

type serverPathManager interface {
	SetMSEServer(*Server) []defs.Path // TODO: Define this in defs
	FindPathConf(req defs.PathFindPathConfReq) (*conf.Path, error)
	AddReader(req defs.PathAddReaderReq) (defs.Path, *stream.Stream, error)
}

type serverParent interface {
	logger.Writer
}

// Server is an MSE server.
type Server struct {
	Address         string
	Encryption      bool
	ServerKey       string
	ServerCert      string
	AllowOrigin     string
	TrustedProxies  conf.IPNetworks
	ReadTimeout     conf.Duration
	MuxerCloseAfter conf.Duration // TODO: Add MSE specific configs if any
	Metrics         serverMetrics
	PathManager     serverPathManager
	Parent          serverParent

	ctx        context.Context
	ctxCancel  func()
	wg         sync.WaitGroup
	httpServer *httpp.Server // Using httpp.Server directly for now
	muxers     map[string]*muxer

	// in
	chPathReady    chan defs.Path
	chPathNotReady chan defs.Path
	chGetMuxer     chan serverGetMuxerReq
	chCloseMuxer   chan *muxer
	chAPIMuxerList chan serverAPIMuxersListReq
	chAPIMuxerGet  chan serverAPIMuxersGetReq
}

// Initialize initializes the server.
func (s *Server) Initialize() error {
	ctx, ctxCancel := context.WithCancel(context.Background())

	s.ctx = ctx
	s.ctxCancel = ctxCancel
	s.muxers = make(map[string]*muxer)
	s.chPathReady = make(chan defs.Path)
	s.chPathNotReady = make(chan defs.Path)
	s.chGetMuxer = make(chan serverGetMuxerReq)
	s.chCloseMuxer = make(chan *muxer)
	s.chAPIMuxerList = make(chan serverAPIMuxersListReq)
	s.chAPIMuxerGet = make(chan serverAPIMuxersGetReq)

	// TODO: Setup HTTP server and routes for MSE
	// Example:
	// router := gin.New()
	// router.SetTrustedProxies(s.TrustedProxies.ToTrustedProxies())
	// router.GET("/mse/:path", s.handleRequest) // This will be the main entry point

	// s.httpServer = &httpp.Server{
	// 	Address:    s.Address,
	// 	Encryption: s.Encryption,
	// 	ServerKey:  s.ServerKey,
	// 	ServerCert: s.ServerCert,
	// 	Handler:    router,
	// 	Parent:     s,
	// }
	// err := s.httpServer.Initialize()
	// if err != nil {
	// 	ctxCancel()
	// 	return err
	// }

	s.Log(logger.Info, "listener opened on "+s.Address+" for MSE")

	s.wg.Add(1)
	go s.run()

	if !interfaceIsEmpty(s.Metrics) {
		// s.Metrics.SetMSEServer(s) // TODO: Uncomment when defs are updated
	}

	return nil
}

// Log implements logger.Writer.
func (s *Server) Log(level logger.Level, format string, args ...interface{}) {
	s.Parent.Log(level, "[MSE] "+format, args...)
}

// Close closes the server.
func (s *Server) Close() {
	s.Log(logger.Info, "listener is closing")

	if !interfaceIsEmpty(s.Metrics) {
		// s.Metrics.SetMSEServer(nil) // TODO: Uncomment when defs are updated
	}

	s.ctxCancel()
	s.wg.Wait()
}

func (s *Server) run() {
	defer s.wg.Done()

	// readyPaths := s.PathManager.SetMSEServer(s) // TODO: Uncomment when defs are updated
	// defer s.PathManager.SetMSEServer(nil) // TODO: Uncomment when defs are updated

	// TODO: Handle initial paths if needed (e.g. AlwaysRemux equivalent for MSE)

outer:
	for {
		select {
		case pa := <-s.chPathReady:
			// TODO: Handle path ready (e.g. AlwaysRemux equivalent for MSE)
			s.Log(logger.Debug, "Path %s ready for MSE", pa.Name())

		case pa := <-s.chPathNotReady:
			// TODO: Handle path not ready
			c, ok := s.muxers[pa.Name()]
			if ok && c.remoteAddr == "" { // created with "always remux"
				c.Close()
				delete(s.muxers, pa.Name())
			}
			s.Log(logger.Debug, "Path %s not ready for MSE", pa.Name())


		case req := <-s.chGetMuxer:
			mux, ok := s.muxers[req.path]
			switch {
			case ok:
				req.res <- serverGetMuxerRes{muxer: mux}
			// case s.AlwaysRemux && !req.sourceOnDemand: // TODO: MSE equivalent
			// 	req.res <- serverGetMuxerRes{err: fmt.Errorf("muxer is waiting to be created")}
			default:
				req.res <- serverGetMuxerRes{muxer: s.createMuxer(req.path, req.remoteAddr, req.query)}
			}

		case c := <-s.chCloseMuxer:
			if c2, ok := s.muxers[c.PathName()]; ok && c2 == c {
				delete(s.muxers, c.PathName())
			}

		case req := <-s.chAPIMuxerList:
			// TODO: Implement API listing if needed
			req.res <- serverAPIMuxersListRes{
				// data: data,
			}

		case req := <-s.chAPIMuxerGet:
			// TODO: Implement API get if needed
			// muxer, ok := s.muxers[req.name]
			// if !ok {
			// 	req.res <- serverAPIMuxersGetRes{err: ErrMuxerNotFound}
			// 	continue
			// }
			req.res <- serverAPIMuxersGetRes{ /*data: muxer.apiItem()*/ }

		case <-s.ctx.Done():
			break outer
		}
	}

	s.ctxCancel()

	if s.httpServer != nil {
		s.httpServer.Close()
	}
}

func (s *Server) createMuxer(pathName string, remoteAddr string, query string) *muxer {
	r := &muxer{
		parentCtx:   s.ctx,
		remoteAddr:  remoteAddr,
		wg:          &s.wg,
		pathName:    pathName,
		pathManager: s.PathManager,
		parent:      s,
		query:       query,
		closeAfter:  s.MuxerCloseAfter,
	}
	r.initialize()
	s.muxers[pathName] = r
	return r
}

// closeMuxer is called by muxer.
func (s *Server) closeMuxer(c *muxer) {
	select {
	case s.chCloseMuxer <- c:
	case <-s.ctx.Done():
	}
}

func (s *Server) getMuxer(req serverGetMuxerReq) (*muxer, error) {
	req.res = make(chan serverGetMuxerRes)

	select {
	case s.chGetMuxer <- req:
		res := <-req.res
		return res.muxer, res.err

	case <-s.ctx.Done():
		return nil, fmt.Errorf("terminated")
	}
}

// PathReady is called by pathManager.
func (s *Server) PathReady(pa defs.Path) {
	select {
	case s.chPathReady <- pa:
	case <-s.ctx.Done():
	}
}

// PathNotReady is called by pathManager.
func (s *Server) PathNotReady(pa defs.Path) {
	select {
	case s.chPathNotReady <- pa:
	case <-s.ctx.Done():
	}
}

// APIMuxersList is called by api.
func (s *Server) APIMuxersList() (*defs.APIMSEMuxerList, error) {
	req := serverAPIMuxersListReq{
		res: make(chan serverAPIMuxersListRes),
	}

	select {
	case s.chAPIMuxerList <- req:
		res := <-req.res
		return res.data, res.err

	case <-s.ctx.Done():
		return nil, fmt.Errorf("terminated")
	}
}

// APIMuxersGet is called by api.
func (s *Server) APIMuxersGet(name string) (*defs.APIMSEMuxer, error) {
	req := serverAPIMuxersGetReq{
		name: name,
		res:  make(chan serverAPIMuxersGetRes),
	}

	select {
	case s.chAPIMuxerGet <- req:
		res := <-req.res
		return res.data, res.err

	case <-s.ctx.Done():
		return nil, fmt.Errorf("terminated")
	}
}

// Muxer is a MSE muxer.
type muxer struct {
	parentCtx   context.Context
	remoteAddr  string
	wg          *sync.WaitGroup
	pathName    string
	pathManager serverPathManager
	parent      *Server
	query       string
	closeAfter  conf.Duration

	ctx       context.Context
	ctxCancel func()
	// TODO: Add MSE specific fields (e.g. fMP4 segment generator)
}

func (m *muxer) initialize() {
	m.ctx, m.ctxCancel = context.WithCancel(m.parentCtx)

	// TODO: Initialize MSE muxer (e.g. fMP4 segment generator)

	m.parent.Log(logger.Info, "muxer for path '%s' created", m.pathName)
}

// Close closes the muxer.
func (m *muxer) Close() {
	m.ctxCancel()
	m.parent.Log(logger.Info, "muxer for path '%s' closed", m.pathName)
}

// PathName returns the path name.
func (m *muxer) PathName() string {
	return m.pathName
}

// HandleRequest handles an HTTP request.
func (s *Server) HandleRequest(ctx *gin.Context) {
	pathName, ok := s.pathManager.FindPathConf(defs.PathFindPathConfReq{
		AccessRequest: defs.PathAccessRequest{
			Name:  ctx.Param("path")[1:], // Remove leading slash
			Query: ctx.Request.URL.RawQuery,
			Req:   ctx.Request,
		},
	})
	if !ok {
		ctx.Status(http.StatusNotFound)
		return
	}

	muxer, err := s.getMuxer(serverGetMuxerReq{
		path:           pathName.Name,
		remoteAddr:     ctx.ClientIP(),
		query:          ctx.Request.URL.RawQuery,
		sourceOnDemand: pathName.SourceOnDemand,
	})
	if err != nil {
		s.Log(logger.Error, "Error getting muxer: %v", err)
		ctx.Status(http.StatusInternalServerError)
		return
	}

	// TODO: Implement MSE streaming logic using the muxer
	// This will involve:
	// 1. Setting appropriate headers (e.g. Content-Type: video/mp4)
	// 2. Sending the initialization segment
	// 3. Sending media segments as they become available

	ctx.Header("Content-Type", "video/mp4") // Example, adjust as needed
	// Simulate sending some data
	ctx.Status(http.StatusOK)
	ctx.Writer.WriteString("MSE stream for " + pathName.Name) // Placeholder
	s.Log(logger.Info, "MSE stream started for path %s", pathName.Name)

	// Keep the connection open for streaming if necessary, or close after sending data
	// For true MSE, this would involve a more complex interaction of sending segments.
}

// This function will be called by the API layer to initiate MSE streaming
func (a *API) onMSEStream(ctx *gin.Context) {
	// TODO: Get or create an MSE server instance.
	// This might involve a new field in the API struct for the MSE server, similar to HLSServer.
	// For now, let's assume we have an mseServer instance.
	// mseServer := a.MSEServer // Assuming MSEServer is added to API struct

	// Placeholder: Directly call a hypothetical HandleRequest method on a manually created server instance
	// This is NOT the final approach but helps in structuring.
	// In reality, the API handler would likely delegate to the MSE server component.

	pathName := ctx.Param("path")
	if pathName == "" {
		a.writeError(ctx, http.StatusBadRequest, fmt.Errorf("path is missing"))
		return
	}

	// Simulate finding path configuration (this logic would normally be in PathManager)
	// pathConf, err := a.PathManager.FindPathConf(defs.PathFindPathConfReq{ AccessRequest: defs.PathAccessRequest{ Name: pathName[1:] }})
	// if err != nil {
	// 	a.writeError(ctx, http.StatusNotFound, fmt.Errorf("path not found: %s", pathName))
	// 	return
	// }


	// This is a simplified call. The actual MSE server's HandleRequest
	// would be registered with the Gin router and handle context directly.
	// mseServer.HandleRequest(ctx) // This line is conceptual

	// The following is a placeholder for what the MSE server's HandleRequest would do.
	// It's simplified for this step.
	ctx.Header("Content-Type", "video/mp4") // Example content type for fMP4
	ctx.Status(http.StatusOK)
	// Simulate sending an initialization segment or some data
	_, err := ctx.Writer.WriteString("Streaming MSE for path: " + pathName)
	if err != nil {
		a.Log(logger.Error, "Error writing MSE response: %v", err)
	}
	a.Log(logger.Info, "MSE stream initiated for path: "+pathName)
}

// Ensure that the API struct has a reference to the MSE server, similar to other servers.
// This will require modifying the API struct definition and its initialization.
// e.g., add MSEServer defs.APIMSEServer to the API struct
// and initialize it in the NewAPI function.

// Also, the MSE server needs to be registered with the path manager,
// similar to how HLSServer is registered.
// This involves:
// 1. Defining SetMSEServer on PathManager.
// 2. Calling SetMSEServer in Server.Initialize().
// 3. Defining APIMSEServer, APIMSEMuxerList, APIMSEMuxer in defs.go.

// The handleRequest function in mse/server.go needs to be properly
// integrated with the HTTP server, typically by registering it as a route handler
// in Server.Initialize(). The current onMSEStream in api.go is a placeholder
// and should eventually delegate to this registered handler or a similar mechanism.
// For now, the onMSEStream in api.go will just return a placeholder response.
// The actual streaming logic will be built out in the mse.Server.HandleRequest.

// The muxer logic in mse/server.go (createMuxer, getMuxer, closeMuxer)
// and the interaction with mse/from_stream.go (mseprotocol.FromStream)
// will form the core of the MSE streaming functionality.
// The FromStream function will take data from the mediamtx stream
// and package it into fMP4 segments, which the muxer then delivers via HTTP.
