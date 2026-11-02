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
	Purpose      string `json:"purpose,omitempty"`
	LastSaved    string `json:"-"`
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
		nonce := make([]byte, 8)
		if _, err = rand.Read(nonce); err != nil {
			_ = os.Remove(initial.Name())
			return OfficeSession{}, err
		}
		key = key + "-view-" + base[:16] + "-" + hex.EncodeToString(nonce)
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
	if err = o.record(*session); err != nil {
		if mode != "view" {
			o.Files.EndOffice(path, key)
		}
		_ = os.Remove(initial.Name())
		return OfficeSession{}, err
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
	return o.request(key, owner, false, "save")
}
func (o *Office) RequestLatest(key, owner string) (OfficeSession, error) {
	return o.request(key, owner, true, "save")
}
func (o *Office) RequestCopy(key, owner string) (OfficeSession, error) {
	return o.request(key, owner, true, "copy")
}
func (o *Office) request(key, owner string, latest bool, purpose string) (OfficeSession, error) {
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
	s.Purpose = purpose
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
		old, recordErr := o.Record(key)
		if recordErr == nil {
			o.preserve(old, candidate, ErrUnassociated.Error())
		}
		return old, ErrUnassociated
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
	if copy.Purpose == "copy" {
		o.mu.Lock()
		defer o.mu.Unlock()
		current := o.sessions[key]
		if current == nil || current.Pending != request {
			return copy, ErrUnassociated
		}
		current.Candidate = candidate
		current.State = "converted"
		current.Pending = ""
		current.SavedRequest = request
		current.Failure = ""
		o.preserve(*current, candidate, "用户请求另存的转换结果")
		return *current, nil
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
	if s.LastSaved != "" && s.LastSaved != candidate {
		_ = os.Remove(s.LastSaved)
	}
	s.LastSaved = candidate
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
	if s.LastSaved != "" && s.LastSaved != copy.Candidate {
		_ = os.Remove(s.LastSaved)
	}
	s.LastSaved = copy.Candidate
	return *s, nil
}
func (o *Office) End(key, owner string, discard bool) error {
	unlock, err := o.Files.Lock(context.Background())
	if err != nil {
		return err
	}
	defer unlock()
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
	s.State = "closed"
	if s.Mode == "view" {
		_ = os.Remove(filepath.Join(o.Root, "sessions", key+".json"))
	} else {
		_ = o.record(*s)
	}
	delete(o.sessions, key)
	o.Files.EndOffice(s.Path, key)
	_ = os.Remove(s.Initial)
	if s.LastSaved != "" && s.LastSaved != s.Candidate {
		_ = os.Remove(s.LastSaved)
	}
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

func (o *Office) Bind(key, source, path string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := o.sessions[key]; s != nil {
		s.Source = source
		s.IndexPath = path
		return o.record(*s)
	}
	return errors.New("Office 会话不存在")
}
func (o *Office) preserve(s OfficeSession, candidate, reason string) {
	data, _ := json.MarshalIndent(map[string]any{"session": s, "candidate": candidate, "reason": reason}, "", "  ")
	_ = os.WriteFile(candidate+".json", data, 0600)
}

// Session records preserve the association needed to retain a converter result
// after a service crash. They are recovery metadata, never persistent locks.
func (o *Office) record(session OfficeSession) error {
	dir := filepath.Join(o.Root, "sessions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(session)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), filepath.Join(dir, session.Key+".json"))
}
func (o *Office) Record(key string) (OfficeSession, error) {
	if filepath.Base(key) != key || key == "." || key == ".." || key == "" {
		return OfficeSession{}, errors.New("无效的 Office key")
	}
	data, err := os.ReadFile(filepath.Join(o.Root, "sessions", key+".json"))
	if err != nil {
		return OfficeSession{}, err
	}
	var s OfficeSession
	err = json.Unmarshal(data, &s)
	return s, err
}

func (o *Office) Active() []OfficeSession {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := []OfficeSession{}
	for _, session := range o.sessions {
		if session.Mode != "view" {
			out = append(out, *session)
		}
	}
	return out
}

func (o *Office) CopyUnchanged(key, request string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	s := o.sessions[key]
	if s == nil || s.Pending != request {
		return ErrUnassociated
	}
	if s.Candidate == "" {
		source := s.LastSaved
		if source == "" {
			source = s.Initial
		}
		in, err := os.Open(source)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := o.CandidatePath()
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		s.Candidate = out.Name()
	}
	s.Pending = ""
	s.SavedRequest = request
	s.State = "converted"
	o.preserve(*s, s.Candidate, "用户请求另存的转换结果")
	return nil
}

func (o *Office) RetainFailed(key, candidate, message string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if s := o.sessions[key]; s != nil {
		o.preserve(*s, candidate, message)
		s.Failure = message
		s.State = "failed"
		s.Pending = ""
	}
}
