package workspace

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

var ErrUnassociated = errors.New("保存结果无法关联当前请求，已保留恢复文件而未覆盖原文")

type OfficeSession struct {
	Source       string `json:"source"`
	IndexPath    string `json:"path"`
	Key          string `json:"key"`
	Path         string `json:"canonicalPath"`
	Owner        string `json:"owner"`
	Mode         string `json:"mode"`
	Base         string `json:"version"`
	State        string `json:"state"`
	Pending      string `json:"pending,omitempty"`
	SavedRequest string `json:"savedRequest,omitempty"`
	Candidate    string `json:"candidate,omitempty"`
	Failure      string `json:"error,omitempty"`
	Initial      string `json:"-"`
	sequence     uint64
}
type Office struct {
	Files    *Store
	Root     string
	mu       sync.Mutex
	sessions map[string]*OfficeSession
}

func NewOffice(files *Store, root string) *Office {
	return &Office{Files: files, Root: root, sessions: make(map[string]*OfficeSession)}
}
func (o *Office) Open(ctx context.Context, path, key, mode, owner string) (OfficeSession, error) {
	unlock, err := o.Files.Lock(ctx)
	if err != nil {
		return OfficeSession{}, err
	}
	defer unlock()
	path, err = Canonical(path)
	if err != nil {
		return OfficeSession{}, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if mode != "view" {
		for _, old := range o.sessions {
			if old.Path == path && old.Mode != "view" {
				if old.Owner != owner || old.Mode != mode {
					return OfficeSession{}, ErrActive
				}
				return *old, nil
			}
		}
	}
	if err = os.MkdirAll(o.Root, 0700); err != nil {
		return OfficeSession{}, err
	}
	in, err := os.Open(path)
	if err != nil {
		return OfficeSession{}, err
	}
	defer in.Close()
	initial, err := os.CreateTemp(o.Root, "initial-*")
	if err != nil {
		return OfficeSession{}, err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(initial, hash), in)
	closeErr := initial.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(initial.Name())
		if copyErr != nil {
			return OfficeSession{}, copyErr
		}
		return OfficeSession{}, closeErr
	}
	base := hex.EncodeToString(hash.Sum(nil))
	if mode == "view" {
		key = key + "-view-" + base[:16]
	} else {
		nonce := make([]byte, 8)
		if _, err = rand.Read(nonce); err != nil {
			_ = os.Remove(initial.Name())
			return OfficeSession{}, err
		}
		key = key + "-edit-" + hex.EncodeToString(nonce)
	}
	if old, ok := o.sessions[key]; ok {
		_ = os.Remove(initial.Name())
		return *old, nil
	}
	session := &OfficeSession{Key: key, Path: path, Owner: owner, Mode: mode, Base: base, State: "saved", Initial: initial.Name()}
	if mode != "view" {
		o.Files.mu.Lock()
		if active, ok := o.Files.active[path]; ok && active != key {
			o.Files.mu.Unlock()
			_ = os.Remove(initial.Name())
			return OfficeSession{}, ErrActive
		}
		o.Files.active[path] = key
		o.Files.mu.Unlock()
	}
	o.sessions[key] = session
	return *session, nil
}
func (o *Office) Get(key string) (OfficeSession, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	s, ok := o.sessions[key]
	if !ok {
		return OfficeSession{}, errors.New("Office 会话不存在或服务已重启")
	}
	return *s, nil
}
func (o *Office) Request(key, owner string) (OfficeSession, error) {
	return o.request(key, owner, false)
}
func (o *Office) RequestLatest(key, owner string) (OfficeSession, error) {
	return o.request(key, owner, true)
}
func (o *Office) request(key, owner string, latest bool) (OfficeSession, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	s, ok := o.sessions[key]
	if !ok {
		return OfficeSession{}, errors.New("Office 会话不存在")
	}
	if s.Owner != owner || s.Mode == "view" {
		return OfficeSession{}, errors.New("该页面不是可写 Office 会话")
	}
	if !latest && (s.State == "conflict" || s.Candidate != "") {
		return *s, &Conflict{}
	}
	if s.Pending != "" {
		return *s, nil
	}
	s.sequence++
	s.Pending = fmt.Sprintf("%s:%d", key, s.sequence)
	s.State = "saving"
	s.Failure = ""
	return *s, nil
}
func (o *Office) NoChanges(key, request string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := o.sessions[key]; s != nil && s.Pending == request {
		s.SavedRequest = request
		s.Pending = ""
		s.State = "saved"
		if s.Candidate != "" {
			s.State = "conflict"
		}
	}
}
func (o *Office) Fail(key, message string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := o.sessions[key]; s != nil {
		s.State = "failed"
		s.Failure = message
		s.Pending = ""
	}
}
func (o *Office) Commit(ctx context.Context, key, request, candidate string) (OfficeSession, error) {
	o.mu.Lock()
	s, ok := o.sessions[key]
	if !ok {
		o.mu.Unlock()
		return OfficeSession{}, ErrUnassociated
	}
	copy := *s
	o.mu.Unlock()
	candidateVersion, err := Version(candidate)
	if err != nil {
		return copy, err
	}
	if copy.Base == candidateVersion && (request == copy.SavedRequest || request == "") {
		_ = os.Remove(candidate)
		return copy, nil
	}
	if request == "" || request != copy.Pending {
		// Keep the file on disk for recovery but never let a delayed result
		// replace a newer in-flight result or establish a new baseline.
		o.preserve(copy, candidate, ErrUnassociated.Error())
		return copy, ErrUnassociated
	}
	version, err := o.Files.Save(ctx, copy.Path, copy.Base, candidate, key)
	o.mu.Lock()
	defer o.mu.Unlock()
	s = o.sessions[key]
	if s == nil {
		return copy, ErrUnassociated
	}
	if err != nil {
		s.State = "failed"
		var conflict *Conflict
		if errors.As(err, &conflict) {
			s.State = "conflict"
		}
		s.Failure = err.Error()
		s.Candidate = candidate
		o.preserve(*s, candidate, err.Error())
		s.Pending = ""
		return *s, err
	}
	s.Base = version
	s.State = "saved"
	s.Pending = ""
	s.SavedRequest = request
	s.Failure = ""
	s.Candidate = ""
	_ = os.Remove(candidate)
	return *s, nil
}
func (o *Office) Resolve(ctx context.Context, key, owner, expected string) (OfficeSession, error) {
	copy, err := o.Get(key)
	if err != nil {
		return copy, err
	}
	if copy.Owner != owner || copy.Candidate == "" {
		return copy, errors.New("没有可处理的当前保存候选")
	}
	version, err := o.Files.Save(ctx, copy.Path, expected, copy.Candidate, key)
	if err != nil {
		return copy, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	s := o.sessions[key]
	if s == nil {
		return copy, ErrUnassociated
	}
	if s.Candidate != copy.Candidate {
		return *s, ErrUnassociated
	}
	s.Base = version
	s.Candidate = ""
	s.State = "saved"
	s.Failure = ""
	_ = os.Remove(copy.Candidate)
	return *s, nil
}
func (o *Office) End(key, owner string, discard bool) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	s, ok := o.sessions[key]
	if !ok {
		return nil
	}
	if s.Owner != owner && s.Mode != "view" {
		return errors.New("会话归属不匹配")
	}
	if !discard && (s.Pending != "" || s.Candidate != "" || s.State != "saved") {
		return errors.New("请先完成保存或明确处理未保存修改")
	}
	// discard never removes retained conflict candidates; explicit reloading
	// may abandon the editor, but recovery data remains on disk.
	delete(o.sessions, key)
	o.Files.EndOffice(s.Path, key)
	_ = os.Remove(s.Initial)
	return nil
}
func (o *Office) CandidatePath() (*os.File, error) {
	if err := os.MkdirAll(o.Root, 0700); err != nil {
		return nil, err
	}
	return os.CreateTemp(o.Root, "candidate-*")
}
func (o *Office) InitialPath(key string) (string, error) {
	s, err := o.Get(key)
	if err != nil {
		return "", err
	}
	return filepath.Clean(s.Initial), nil
}

func (o *Office) Bind(key, source, path string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := o.sessions[key]; s != nil {
		s.Source = source
		s.IndexPath = path
	}
}
func (o *Office) preserve(s OfficeSession, candidate, reason string) {
	data, _ := json.MarshalIndent(map[string]any{"session": s, "candidate": candidate, "reason": reason}, "", "  ")
	_ = os.WriteFile(candidate+".json", data, 0600)
}
