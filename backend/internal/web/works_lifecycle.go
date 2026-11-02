package web

import (
	"encoding/json"
	"github.com/gtsteffaniak/filebrowser/backend/internal/version"
	"net/http"
	"sync"
	"time"
)

type worksLease struct {
	Owner string    `json:"owner"`
	Path  string    `json:"canonicalPath"`
	Dirty bool      `json:"dirty"`
	State string    `json:"state"`
	Seen  time.Time `json:"-"`
}

var worksLivePages = struct {
	sync.Mutex
	pages map[string]worksLease
}{pages: map[string]worksLease{}}

func worksLifecyclePost(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	var input worksLease
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&input); err != nil {
		return http.StatusBadRequest, err
	}
	if input.Owner == "" || len(input.Owner) > 128 {
		return http.StatusBadRequest, nil
	}
	input.Seen = time.Now()
	worksLivePages.Lock()
	if !input.Dirty && input.State != "saving" {
		delete(worksLivePages.pages, input.Owner)
	} else {
		worksLivePages.pages[input.Owner] = input
	}
	worksLivePages.Unlock()
	return RenderJSON(w, r, map[string]bool{"recorded": true})
}
func worksLifecycleGet(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	now := time.Now()
	blocked := []worksLease{}
	worksLivePages.Lock()
	for owner, lease := range worksLivePages.pages {
		if now.Sub(lease.Seen) > 120*time.Second {
			delete(worksLivePages.pages, owner)
			continue
		}
		blocked = append(blocked, lease)
	}
	worksLivePages.Unlock()
	office := worksOffice.Active()
	return RenderJSON(w, r, map[string]any{"readyForRestart": len(blocked) == 0 && len(office) == 0, "pendingPages": blocked, "officeEditors": office, "revision": version.CommitSHA})
}
