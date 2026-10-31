package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const token = "0123456789abcdef0123456789abcdef-test"
const roomID = "room-abcdefghijklmnop"

func dial(t *testing.T, srv *httptest.Server, path string, auth bool) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{HTTPHeader: http.Header{}}
	if auth {
		opts.HTTPHeader.Set("Authorization", "Bearer "+token)
	}
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+path, opts)
}

func read(t *testing.T, c *websocket.Conn) (websocket.MessageType, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	return typ, string(data), err
}

func write(t *testing.T, c *websocket.Conn, typ websocket.MessageType, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, typ, []byte(text)); err != nil {
		t.Fatal(err)
	}
}

func setup(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(NewRelay(token).Handler())
	t.Cleanup(srv.Close)
	return srv
}

// The Mac side of one phone: hear "peer", answer it.
func answer(t *testing.T, srv *httptest.Server, host *websocket.Conn) *websocket.Conn {
	t.Helper()
	_, note, err := read(t, host)
	if err != nil {
		t.Fatal(err)
	}
	var peer struct{ T, ID string }
	json.Unmarshal([]byte(note), &peer)
	if peer.T != "peer" || peer.ID == "" {
		t.Fatalf("expected a peer note, got %s", note)
	}
	mac, _, err := dial(t, srv, "/accept?room="+roomID+"&peer="+peer.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	return mac
}

func TestHealthAndAuth(t *testing.T) {
	srv := setup(t)
	res, err := http.Get(srv.URL + "/health")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health: %v %v", err, res)
	}
	if _, res, err := dial(t, srv, "/host?room="+roomID, false); err == nil || res.StatusCode != 401 {
		t.Fatal("a Mac without the token must be refused")
	}
	if _, res, err := dial(t, srv, "/host?room=short", true); err == nil || res.StatusCode != 400 {
		t.Fatal("a malformed room must be refused")
	}
	if _, res, err := dial(t, srv, "/accept?room="+roomID+"&peer=x", false); err == nil || res.StatusCode != 401 {
		t.Fatal("an answer without the token must be refused")
	}
}

func TestPhoneWithoutMacHearsOffline(t *testing.T) {
	srv := setup(t)
	phone, _, err := dial(t, srv, "/join?room="+roomID, false)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = read(t, phone)
	if websocket.CloseStatus(err) != 4404 {
		t.Fatalf("expected 4404, got %v", err)
	}
}

func TestFramesPassBothWaysAndCloseCodesTravel(t *testing.T) {
	srv := setup(t)
	host, _, err := dial(t, srv, "/host?room="+roomID, true)
	if err != nil {
		t.Fatal(err)
	}
	phone, _, err := dial(t, srv, "/join?room="+roomID, false)
	if err != nil {
		t.Fatal(err)
	}
	// The phone may speak before the Mac answers; nothing is lost.
	write(t, phone, websocket.MessageText, `{"t":"hello"}`)
	mac := answer(t, srv, host)
	if typ, text, _ := read(t, mac); typ != websocket.MessageText || text != `{"t":"hello"}` {
		t.Fatalf("mac got %v %q", typ, text)
	}
	write(t, mac, websocket.MessageBinary, "\x00sealed")
	if typ, text, _ := read(t, phone); typ != websocket.MessageBinary || text != "\x00sealed" {
		t.Fatalf("phone got %v %q", typ, text)
	}
	// The Mac turns the phone away; the phone hears exactly why.
	mac.Close(4003, "revoked")
	_, _, err = read(t, phone)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != 4003 || ce.Reason != "revoked" {
		t.Fatalf("expected 4003 revoked, got %v", err)
	}
	// An answer for a phone that is gone finds nothing.
	if _, res, err := dial(t, srv, "/accept?room="+roomID+"&peer=nope", true); err == nil || res.StatusCode != 404 {
		t.Fatal("answering an unknown phone must fail")
	}
}

func TestSilentMacTimesOut(t *testing.T) {
	answerWithin = 300 * time.Millisecond
	defer func() { answerWithin = 10 * time.Second }()
	srv := setup(t)
	host, _, err := dial(t, srv, "/host?room="+roomID, true)
	if err != nil {
		t.Fatal(err)
	}
	defer host.CloseNow()
	phone, _, err := dial(t, srv, "/join?room="+roomID, false)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = read(t, phone)
	if websocket.CloseStatus(err) != 4504 {
		t.Fatalf("expected 4504, got %v", err)
	}
}

func TestNewerMacReplacesOlderAndPhonesAreCapped(t *testing.T) {
	srv := setup(t)
	first, _, _ := dial(t, srv, "/host?room="+roomID, true)
	second, _, err := dial(t, srv, "/host?room="+roomID, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := read(t, first); websocket.CloseStatus(err) != 4009 {
		t.Fatalf("expected 4009, got %v", err)
	}
	var macs []*websocket.Conn
	for i := 0; i < maxPeers; i++ {
		phone, _, err := dial(t, srv, "/join?room="+roomID, false)
		if err != nil {
			t.Fatal(err)
		}
		defer phone.CloseNow()
		macs = append(macs, answer(t, srv, second))
	}
	extra, _, _ := dial(t, srv, "/join?room="+roomID, false)
	if _, _, err := read(t, extra); websocket.CloseStatus(err) != 4429 {
		t.Fatalf("expected 4429, got %v", err)
	}
	for _, m := range macs {
		m.CloseNow()
	}
}
