package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixture(t *testing.T) (string, string, string) {
	t.Helper()
	d := t.TempDir()
	p := filepath.Join(d, "中文 原文.txt")
	c := filepath.Join(d, "candidate")
	if e := os.WriteFile(p, []byte("原文\r\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(c, []byte("新内容 😀\r\n"), 0600); e != nil {
		t.Fatal(e)
	}
	v, e := Version(p)
	if e != nil {
		t.Fatal(e)
	}
	return p, c, v
}
func TestExternalChangeCannotBeOverwritten(t *testing.T) {
	p, c, v := fixture(t)
	s := New(nil)
	_ = os.WriteFile(p, []byte("agent 修改"), 0600)
	_, e := s.Save(context.Background(), p, v, c, "")
	var conflict *Conflict
	if !errors.As(e, &conflict) {
		t.Fatalf("wanted conflict, got %v", e)
	}
	data, _ := os.ReadFile(p)
	if string(data) != "agent 修改" {
		t.Fatal("external content lost")
	}
	// Explicit overwrite still compares the version most recently confirmed.
	_, e = s.Save(context.Background(), p, conflict.Actual, c, "")
	if e != nil {
		t.Fatal(e)
	}
	data, _ = os.ReadFile(p)
	if string(data) != "新内容 😀\r\n" {
		t.Fatal("roundtrip corrupted")
	}
	info, _ := os.Stat(p)
	if info.Mode().Perm() != 0600 {
		t.Fatal("permissions changed")
	}
}
func TestConcurrentSavesUseOneBaseline(t *testing.T) {
	p, c, v := fixture(t)
	s := New(nil)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, e := s.Save(context.Background(), p, v, c, ""); results <- e }()
	}
	good, bad := 0, 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			good++
		} else {
			bad++
		}
	}
	if good != 1 || bad != 1 {
		t.Fatalf("wanted one commit and one conflict, got %d/%d", good, bad)
	}
}
func TestOfficeProtectsAncestorsAndOnlyOwnerSaves(t *testing.T) {
	p, c, v := fixture(t)
	s := New(nil)
	if e := s.BeginOffice(p, "key"); e != nil {
		t.Fatal(e)
	}
	if !errors.Is(s.CheckActive(filepath.Dir(p)), ErrActive) {
		t.Fatal("ancestor was not protected")
	}
	if _, e := s.Save(context.Background(), p, v, c, ""); !errors.Is(e, ErrActive) {
		t.Fatal(e)
	}
	if _, e := s.Save(context.Background(), p, v, c, "wrong"); e == nil {
		t.Fatal("wrong Office key accepted")
	}
	if _, e := s.Save(context.Background(), p, v, c, "key"); e != nil {
		t.Fatal(e)
	}
	s.EndOffice(p, "wrong")
	if s.CheckActive(p) == nil {
		t.Fatal("wrong key released session")
	}
	s.EndOffice(p, "key")
	if e := s.CheckActive(p); e != nil {
		t.Fatal(e)
	}
}
func TestMutationQueueCanBeCancelled(t *testing.T) {
	s := New(nil)
	unlock, e := s.Lock(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, e = s.Lock(ctx); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
}
func TestFailedCandidateDoesNotTruncate(t *testing.T) {
	p, _, v := fixture(t)
	s := New(nil)
	if _, e := s.Save(context.Background(), p, v, p+"-missing", ""); e == nil {
		t.Fatal("missing candidate accepted")
	}
	actual, _ := Version(p)
	if actual != v {
		t.Fatal("original truncated")
	}
}
func TestCanonicalSymlinkAndDistinctParent(t *testing.T) {
	p, _, _ := fixture(t)
	link := p + "-link"
	if e := os.Symlink(p, link); e != nil {
		t.Fatal(e)
	}
	a, e := Canonical(link)
	expected, _ := Canonical(p)
	if e != nil || a != expected {
		t.Fatalf("%s %v", a, e)
	}
	s := New(nil)
	_ = s.BeginOffice(p, "key")
	if e := s.CheckActive(filepath.Dir(p) + "-other"); e != nil {
		t.Fatal("prefix sibling mistaken for ancestor")
	}
}
