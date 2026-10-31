// otter-relay lets a phone reach its Mac's Otter from outside the home
// network. It only passes frames along: everything after the handshake is
// encrypted end to end between the phone and the Mac, so the relay sees
// ciphertext and nothing else.
//
//	GET /host?room=R    the Mac's control line (needs the relay's token)
//	GET /join?room=R    a phone; the relay asks the Mac to answer it
//	GET /accept?room=R&peer=P   the Mac's answer (token), joined to that phone
//	GET /health         "ok"
//
// A room is a random id only the Mac and its paired phones know; only the
// holder of the token can be a room's Mac. Close codes travel end to end, so
// a phone the Mac turns away hears why.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var version = "dev"

const (
	maxFrame    = 1 << 20
	maxRooms    = 200
	maxPeers    = 8
	pingEvery   = 25 * time.Second
	writeWithin = 10 * time.Second
)

// How long a phone waits for its Mac to answer (shorter in tests).
var answerWithin = 10 * time.Second

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

type room struct {
	host    *websocket.Conn
	hostCtx context.Context
	waiting map[string]chan *websocket.Conn
	peers   int
}

type Relay struct {
	token []byte
	mu    sync.Mutex
	rooms map[string]*room
}

func NewRelay(token string) *Relay {
	return &Relay{token: []byte(token), rooms: map[string]*room{}}
}

func (s *Relay) authorized(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return len(s.token) > 0 && subtle.ConstantTimeCompare([]byte(got), s.token) == 1
}

func (s *Relay) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/host", s.host)
	mux.HandleFunc("/join", s.join)
	mux.HandleFunc("/accept", s.accept)
	return mux
}

func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // not a browser endpoint; there is no origin to check
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(maxFrame)
	return c, nil
}

func roomOf(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.URL.Query().Get("room")
	if !roomPattern.MatchString(id) {
		http.Error(w, "bad room", http.StatusBadRequest)
		return "", false
	}
	return id, true
}

// The Mac's control line: it hears "peer" for each phone and answers each
// with an /accept. A newer line for the same room replaces the older.
func (s *Relay) host(w http.ResponseWriter, r *http.Request) {
	id, ok := roomOf(w, r)
	if !ok {
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.mu.Lock()
	if _, exists := s.rooms[id]; !exists && len(s.rooms) >= maxRooms {
		s.mu.Unlock()
		http.Error(w, "full", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()
	c, err := accept(w, r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.mu.Lock()
	rm := s.rooms[id]
	if rm == nil {
		rm = &room{waiting: map[string]chan *websocket.Conn{}}
		s.rooms[id] = rm
	}
	old := rm.host
	rm.host, rm.hostCtx = c, ctx
	s.mu.Unlock()
	if old != nil {
		old.Close(4009, "replaced")
	}
	log.Printf("mac online (%d rooms)", s.count())
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, done := context.WithTimeout(ctx, writeWithin)
				err := c.Ping(pctx)
				done()
				if err != nil {
					c.CloseNow()
					return
				}
			}
		}
	}()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			break
		}
	}
	s.mu.Lock()
	if rm.host == c {
		rm.host = nil
		if len(rm.waiting) == 0 && rm.peers == 0 {
			delete(s.rooms, id)
		}
	}
	s.mu.Unlock()
	c.CloseNow()
	log.Printf("mac offline (%d rooms)", s.count())
}

func (s *Relay) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rooms)
}

func peerID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// A phone: tell the Mac, wait for its answer, then pass frames both ways.
func (s *Relay) join(w http.ResponseWriter, r *http.Request) {
	id, ok := roomOf(w, r)
	if !ok {
		return
	}
	c, err := accept(w, r)
	if err != nil {
		return
	}
	s.mu.Lock()
	rm := s.rooms[id]
	if rm == nil || rm.host == nil {
		s.mu.Unlock()
		c.Close(4404, "mac offline")
		return
	}
	if rm.peers+len(rm.waiting) >= maxPeers {
		s.mu.Unlock()
		c.Close(4429, "busy")
		return
	}
	peer := peerID()
	answer := make(chan *websocket.Conn, 1)
	rm.waiting[peer] = answer
	host, hostCtx := rm.host, rm.hostCtx
	s.mu.Unlock()
	note, _ := json.Marshal(map[string]string{"t": "peer", "id": peer})
	wctx, done := context.WithTimeout(hostCtx, writeWithin)
	err = host.Write(wctx, websocket.MessageText, note)
	done()
	var mac *websocket.Conn
	if err == nil {
		select {
		case mac = <-answer:
		case <-time.After(answerWithin):
		case <-r.Context().Done():
		}
	}
	s.mu.Lock()
	delete(rm.waiting, peer)
	if mac != nil {
		rm.peers++
	}
	s.mu.Unlock()
	if mac == nil {
		c.Close(4504, "mac did not answer")
		return
	}
	splice(c, mac)
	s.mu.Lock()
	rm.peers--
	if rm.host == nil && rm.peers == 0 && len(rm.waiting) == 0 {
		delete(s.rooms, id)
	}
	s.mu.Unlock()
}

// The Mac's answer to one phone; join() does the passing along.
func (s *Relay) accept(w http.ResponseWriter, r *http.Request) {
	id, ok := roomOf(w, r)
	if !ok {
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	peer := r.URL.Query().Get("peer")
	s.mu.Lock()
	var answer chan *websocket.Conn
	if rm := s.rooms[id]; rm != nil {
		answer = rm.waiting[peer]
	}
	s.mu.Unlock()
	if answer == nil {
		http.Error(w, "no such phone", http.StatusNotFound)
		return
	}
	c, err := accept(w, r)
	if err != nil {
		return
	}
	select {
	case answer <- c:
	default:
		c.Close(4409, "already answered")
	}
}

// Frames go both ways untouched; when one side ends, the other hears the
// same close code and reason.
func splice(a, b *websocket.Conn) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ended := make(chan struct{}, 2)
	pass := func(from, to *websocket.Conn) {
		defer func() { ended <- struct{}{} }()
		for {
			typ, data, err := from.Read(ctx)
			if err != nil {
				code := websocket.CloseStatus(err)
				reason := ""
				var ce websocket.CloseError
				if errors.As(err, &ce) {
					reason = ce.Reason
				}
				if code == -1 || code == websocket.StatusNoStatusRcvd {
					code = websocket.StatusGoingAway
				}
				to.Close(code, reason)
				return
			}
			wctx, done := context.WithTimeout(ctx, writeWithin)
			err = to.Write(wctx, typ, data)
			done()
			if err != nil {
				from.CloseNow()
				return
			}
		}
	}
	go pass(a, b)
	go pass(b, a)
	<-ended
	cancel()
	a.CloseNow()
	b.CloseNow()
	<-ended
}

func main() {
	listen := flag.String("listen", ":8787", "address to listen on")
	tokenFile := flag.String("token-file", "", "file holding the token Macs must present (or OTTER_RELAY_TOKEN)")
	cert := flag.String("cert", "", "TLS certificate (serve wss://)")
	key := flag.String("key", "", "TLS key")
	showVersion := flag.Bool("version", false, "print the version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	token := os.Getenv("OTTER_RELAY_TOKEN")
	if *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if err != nil {
			log.Fatalf("token: %v", err)
		}
		token = strings.TrimSpace(string(data))
	}
	if len(token) < 32 {
		log.Fatal("a token of at least 32 characters is required (-token-file or OTTER_RELAY_TOKEN)")
	}
	server := &http.Server{
		Addr:              *listen,
		Handler:           NewRelay(token).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	log.Printf("otter-relay %s listening on %s", version, *listen)
	var err error
	if *cert != "" {
		err = server.ListenAndServeTLS(*cert, *key)
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
