package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateNeverReplacesAndPublishesAllBytes(t *testing.T) {
	path, candidate, _ := fixture(t)
	s := New(nil)
	if _, e := s.Create(context.Background(), path, candidate); !os.IsExist(e) {
		t.Fatal(e)
	}
	newPath := filepath.Join(filepath.Dir(path), "另存为.txt")
	if _, e := s.Create(context.Background(), newPath, candidate); e != nil {
		t.Fatal(e)
	}
	a, _ := os.ReadFile(candidate)
	b, _ := os.ReadFile(newPath)
	if string(a) != string(b) {
		t.Fatal("incomplete publication")
	}
}
