package mse

import (
	_ "embed"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/bluenviron/mediamtx/internal/conf"
	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/bluenviron/mediamtx/internal/protocols/httpp"
	"github.com/bluenviron/mediamtx/internal/restrictnetwork"
)

//go:embed index.html
var mseIndexHTML []byte

//go:embed mse.js
var mseJS []byte

// HTTPServer is an HTTP server that serves static files for MSE playback.
type HTTPServer struct {
	Address        string
	Encryption     bool
	ServerKey      string
	ServerCert     string
	AllowOrigin    string
	TrustedProxies conf.IPNetworks
	ReadTimeout    conf.Duration
	Parent         logger.Writer // Parent for logging

	inner *httpp.Server
}

// Initialize initializes the HTTPServer.
func (s *HTTPServer) Initialize() error {
	router := gin.New()
	router.SetTrustedProxies(s.TrustedProxies.ToTrustedProxies()) //nolint:errcheck

	router.Use(s.middlewareOrigin)
	// No specific auth middleware for static files; auth is handled by the MSE streaming endpoint.

	// Serve files. The path will be like /<stream_name>/mse/
	// We register a wildcard route to catch all paths under /mse/
	// and then specifically handle index.html and mse.js
	router.GET("/*any", s.onRequest)

	network, address := restrictnetwork.Restrict("tcp", s.Address)

	s.inner = &httpp.Server{
		Network:     network,
		Address:     address,
		ReadTimeout: time.Duration(s.ReadTimeout),
		Encryption:  s.Encryption,
		ServerCert:  s.ServerCert,
		ServerKey:   s.ServerKey,
		Handler:     router,
		Parent:      s,
	}
	err := s.inner.Initialize()
	if err != nil {
		return err
	}

	s.Log(logger.Info, "MSE HTTP server listener opened on %s", s.Address)
	return nil
}

// Log implements logger.Writer.
func (s *HTTPServer) Log(level logger.Level, format string, args ...interface{}) {
	if s.Parent != nil {
		s.Parent.Log(level, "[MSE HTTP] "+format, args...)
	}
}

// Close closes the HTTPServer.
func (s *HTTPServer) Close() {
	s.Log(logger.Info, "MSE HTTP server listener is closing")
	if s.inner != nil {
		s.inner.Close()
	}
}

func (s *HTTPServer) middlewareOrigin(ctx *gin.Context) {
	ctx.Header("Access-Control-Allow-Origin", s.AllowOrigin)
	ctx.Header("Access-Control-Allow-Credentials", "true") // If cookies or auth headers are needed

	if ctx.Request.Method == http.MethodOptions &&
		ctx.Request.Header.Get("Access-Control-Request-Method") != "" {
		ctx.Header("Access-Control-Allow-Methods", "GET, OPTIONS")
		ctx.Header("Access-Control-Allow-Headers", "Content-Type") // Adjust as needed
		ctx.AbortWithStatus(http.StatusNoContent)
		return
	}
}

func (s *HTTPServer) onRequest(ctx *gin.Context) {
	reqPath := path.Clean(ctx.Request.URL.Path)

	// Example: /mystream/mse/index.html -> serves index.html
	// Example: /mystream/mse/mse.js -> serves mse.js
	// Example: /mystream/mse/ -> serves index.html (if path ends with /mse/)

	// Check if path ends with /mse.js
	if strings.HasSuffix(reqPath, "/mse.js") {
		s.Log(logger.Debug, "Serving mse.js for request path: %s", reqPath)
		ctx.Header("Cache-Control", "max-age=3600") // Cache for 1 hour
		ctx.Header("Content-Type", "application/javascript")
		ctx.Writer.WriteHeader(http.StatusOK)
		ctx.Writer.Write(mseJS)
		return
	}

	// Check if path ends with / or /index.html within a /mse/ subpath
	// This allows URLs like /streamname/mse/ or /streamname/mse/index.html
	if strings.HasSuffix(reqPath, "/mse/") || strings.HasSuffix(reqPath, "/mse/index.html") {
		s.Log(logger.Debug, "Serving index.html for request path: %s", reqPath)
		ctx.Header("Cache-Control", "no-cache") // Ensure fresh HTML for dev, or use etags
		ctx.Header("Content-Type", "text/html")
		ctx.Writer.WriteHeader(http.StatusOK)
		ctx.Writer.Write(mseIndexHTML)
		return
	}

	// If it's not mse.js or index.html within a /mse/ path structure, return 404
	// This prevents serving arbitrary files if the wildcard is too broad.
	// However, the current wildcard is /*any which means any path not caught above will hit this.
	// A more specific routing like router.GET("/:streamName/mse/", ...) and router.GET("/:streamName/mse/mse.js", ...)
	// would be more robust but requires more complex registration or knowing all stream names.
	// For now, this setup relies on the JS to correctly determine its stream path and request data from /mse/{stream_name_api_endpoint}

	s.Log(logger.Debug, "Path not found for MSE static server: %s", reqPath)
	ctx.Writer.WriteHeader(http.StatusNotFound)
}
