package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOfficeSnapshotConflictRecoveryAndStaleResults(t *testing.T) {
	path, candidate, _ := fixture(t)
	store := New(nil)
	office := NewOffice(store, filepath.Join(t.TempDir(), "office"))
	ctx := context.Background()
	edit, e := office.Open(ctx, path, "document", "edit", "page-a")
	if e != nil {
		t.Fatal(e)
	}
	view, e := office.Open(ctx, path, "document", "view", "side")
	if e != nil {
		t.Fatal(e)
	}
	if view.Key == edit.Key {
		t.Fatal("preview shares live editing key")
	}
	if _, e = office.Open(ctx, path, "document", "edit", "page-b"); !errors.Is(e, ErrActive) {
		t.Fatal("second writer accepted", e)
	}
	request, e := office.Request(edit.Key, "page-a")
	if e != nil {
		t.Fatal(e)
	}
	_ = os.WriteFile(path, []byte("agent"), 0600)
	result, e := office.Commit(ctx, edit.Key, request.Pending, candidate)
	var conflict *Conflict
	if !errors.As(e, &conflict) || result.Candidate == "" {
		t.Fatalf("candidate lost %v %v", result, e)
	}
	if _, e = os.Stat(candidate); e != nil {
		t.Fatal("conflict candidate deleted")
	}
	if e = office.End(edit.Key, "page-a", false); e == nil {
		t.Fatal("conflicted editor closed without decision")
	}
	current, _ := Version(path)
	resolved, e := office.Resolve(ctx, edit.Key, "page-a", current)
	if e != nil {
		t.Fatal(e)
	}
	if resolved.State != "saved" {
		t.Fatal(resolved)
	}
	late := filepath.Join(t.TempDir(), "late")
	_ = os.WriteFile(late, []byte("old result"), 0600)
	if _, e = office.Commit(ctx, edit.Key, "old-request", late); !errors.Is(e, ErrUnassociated) {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "新内容 😀\r\n" {
		t.Fatal("late result overwrote current file")
	}
	if e = office.End(edit.Key, "page-a", false); e != nil {
		t.Fatal(e)
	}
	if e = store.CheckActive(path); e != nil {
		t.Fatal(e)
	}
}

func TestOfficeContinuedEditingRefreshesConflictCandidate(t *testing.T) {
	path, candidate, _ := fixture(t)
	ctx := context.Background()
	o := NewOffice(New(nil), filepath.Join(t.TempDir(), "office"))
	s, e := o.Open(ctx, path, "doc", "edit", "owner")
	if e != nil {
		t.Fatal(e)
	}
	request, e := o.Request(s.Key, "owner")
	if e != nil {
		t.Fatal(e)
	}
	_ = os.WriteFile(path, []byte("external"), 0600)
	first, e := o.Commit(ctx, s.Key, request.Pending, candidate)
	if e == nil || first.Candidate == "" {
		t.Fatal("expected retained first candidate")
	}
	next, e := o.RequestLatest(s.Key, "owner")
	if e != nil {
		t.Fatal(e)
	}
	latest := filepath.Join(t.TempDir(), "latest")
	_ = os.WriteFile(latest, []byte("continued editing"), 0600)
	second, e := o.Commit(ctx, s.Key, next.Pending, latest)
	if e == nil || second.Candidate != latest {
		t.Fatal("latest candidate was not selected", e)
	}
	baseline, _ := Version(path)
	if _, e = o.Resolve(ctx, s.Key, "owner", baseline); e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "continued editing" {
		t.Fatal("old candidate replaced latest edits")
	}
	if _, e = os.Stat(candidate); e != nil {
		t.Fatal("previous recovery candidate was lost")
	}
}
