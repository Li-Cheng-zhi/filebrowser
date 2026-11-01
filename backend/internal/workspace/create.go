package workspace

import (
	"context"
	"io"
	"os"
	"path/filepath"
)

// Create publishes a complete candidate without ever replacing an existing name.
func (s *Store) Create(ctx context.Context, path, candidate string) (string, error) {
	unlock, err := s.Lock(ctx)
	if err != nil {
		return "", err
	}
	defer unlock()
	path, err = Destination(path)
	if err != nil {
		return "", err
	}
	if err = s.CheckActive(path); err != nil {
		return "", err
	}
	input, err := os.Open(candidate)
	if err != nil {
		return "", err
	}
	defer input.Close()
	temp, err := os.CreateTemp(filepath.Dir(path), ".works-create-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	_, err = io.Copy(temp, input)
	if err == nil {
		err = temp.Chmod(0644)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Link(temp.Name(), path); err != nil {
		return "", err
	}
	if dir, e := os.Open(filepath.Dir(path)); e == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return Version(path)
}
