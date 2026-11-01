// Package workspace is the shared correctness boundary for Works file operations.
// Paths identify resources; it does not keep a second copy of the UI tree.
package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

var ErrActive = errors.New("Office 正在编辑或审阅，请先结束编辑")

type Conflict struct {
	Actual string `json:"actualVersion"`
	Absent bool   `json:"absent"`
}

func (e *Conflict) Error() string { return "磁盘文件已变化，当前修改尚未覆盖原文件" }

type Native interface {
	Run(context.Context, string, string, string) (string, error)
}
type NativeCommand struct{ Binary string }

func (n NativeCommand) Run(ctx context.Context, operation, path, destination string) (string, error) {
	if n.Binary == "" {
		return "", errors.New("未配置原生文件操作辅助程序")
	}
	request, err := json.Marshal(map[string]string{"operation": operation, "path": path, "destination": destination})
	if err != nil {
		return "", err
	}
	command := exec.CommandContext(ctx, n.Binary)
	command.Stdin = strings.NewReader(string(request))
	output, runErr := command.Output()
	var result struct {
		OK    bool   `json:"ok"`
		Path  string `json:"path"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return "", fmt.Errorf("原生操作结果无效: %w", err)
	}
	if !result.OK {
		return "", fmt.Errorf("原生文件操作失败: %s", result.Error)
	}
	if runErr != nil {
		return "", runErr
	}
	return result.Path, nil
}

type Store struct {
	gate   chan struct{}
	mu     sync.Mutex
	active map[string]string // canonical path -> Office session key
	Native Native
}

func New(native Native) *Store {
	return &Store{gate: make(chan struct{}, 1), active: make(map[string]string), Native: native}
}

// Lock queues this process's mutations. It neither claims nor creates an OS lock.
func (s *Store) Lock(ctx context.Context) (func(), error) {
	select {
	case s.gate <- struct{}{}:
		return func() { <-s.gate }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func Canonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func Destination(path string) (string, error) {
	parent, err := Canonical(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func Version(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("目标不是普通文件")
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (s *Store) BeginOffice(path, key string) error {
	unlock, lockErr := s.Lock(context.Background())
	if lockErr != nil {
		return lockErr
	}
	defer unlock()
	canonical, err := Canonical(path)
	if err != nil {
		return err
	}
	path = canonical
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.active[path]; ok && old != key {
		return ErrActive
	}
	s.active[path] = key
	return nil
}
func (s *Store) EndOffice(path, key string) {
	if canonical, err := Canonical(path); err == nil {
		path = canonical
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[path] == key {
		delete(s.active, path)
	}
}
func (s *Store) CheckActive(path string) error {
	if canonical, err := Canonical(path); err == nil {
		path = canonical
	} else if canonical, err := Destination(path); err == nil {
		path = canonical
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for file := range s.active {
		if file == path || strings.HasPrefix(file, path+string(filepath.Separator)) {
			return ErrActive
		}
	}
	return nil
}

// Save compares and commits within the mutation queue. candidate is already fully
// downloaded; network latency therefore never holds this queue.
func (s *Store) Save(ctx context.Context, path, expected, candidate, officeKey string) (string, error) {
	unlock, err := s.Lock(ctx)
	if err != nil {
		return "", err
	}
	defer unlock()
	canonical, err := Canonical(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", &Conflict{Absent: true}
		}
		return "", err
	}
	if officeKey == "" {
		if err = s.CheckActive(canonical); err != nil {
			return "", err
		}
	} else {
		s.mu.Lock()
		active := s.active[canonical]
		s.mu.Unlock()
		if active != officeKey {
			return "", errors.New("Office 编辑会话已失效")
		}
	}
	actual, err := Version(canonical)
	if err != nil {
		return "", err
	}
	if expected == "" || actual != expected {
		return "", &Conflict{Actual: actual}
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", err
	}
	in, err := os.Open(candidate)
	if err != nil {
		return "", err
	}
	defer in.Close()
	temporary, err := os.CreateTemp(filepath.Dir(canonical), ".works-save-*")
	if err != nil {
		return "", err
	}
	name := temporary.Name()
	defer os.Remove(name)
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(temporary, h), in)
	if copyErr == nil {
		copyErr = temporary.Chmod(info.Mode().Perm())
	}
	if copyErr == nil {
		copyErr = temporary.Sync()
	}
	closeErr := temporary.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	// Check again immediately before replacement; an external writer is not
	// serialized by our queue. No claim of a cross-process transaction is made.
	actual, err = Version(canonical)
	if err != nil {
		return "", err
	}
	if actual != expected {
		return "", &Conflict{Actual: actual}
	}
	if s.Native != nil {
		_, err = s.Native.Run(ctx, "replace", name, canonical)
	} else {
		err = os.Rename(name, canonical)
	}
	if err != nil {
		return "", err
	}
	if dir, e := os.Open(filepath.Dir(canonical)); e == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
