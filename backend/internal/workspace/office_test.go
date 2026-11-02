package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
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

func TestRestartRetainsUnassociatedConverterResultWithoutLockOrOverwrite(t *testing.T) {
	path, candidate, _ := fixture(t)
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "office")
	old := NewOffice(New(nil), root)
	s, e := old.Open(ctx, path, "document", "edit", "owner")
	if e != nil {
		t.Fatal(e)
	}
	old.Bind(s.Key, "source", "/document.docx")
	freshStore := New(nil)
	fresh := NewOffice(freshStore, root)
	if e = freshStore.CheckActive(path); e != nil {
		t.Fatal("record restored a persistent lock", e)
	}
	if _, e = fresh.Commit(ctx, s.Key, "old request", candidate); !errors.Is(e, ErrUnassociated) {
		t.Fatal(e)
	}
	if _, e = os.Stat(candidate + ".json"); e != nil {
		t.Fatal("lost recovered callback association", e)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "原文\r\n" {
		t.Fatal("unexpected write after restart", string(data))
	}
}

func TestSaveAsConversionNeverWritesOriginalAndNoChangesUsesLatestSavedBytes(t *testing.T) {
	path, candidate, _ := fixture(t)
	ctx := context.Background()
	o := NewOffice(New(nil), filepath.Join(t.TempDir(), "office"))
	s, e := o.Open(ctx, path, "doc", "edit", "owner")
	if e != nil {
		t.Fatal(e)
	}
	copyRequest, e := o.RequestCopy(s.Key, "owner")
	if e != nil {
		t.Fatal(e)
	}
	converted, e := o.Commit(ctx, s.Key, copyRequest.Pending, candidate)
	if e != nil || converted.State != "converted" {
		t.Fatal(converted, e)
	}
	original, _ := os.ReadFile(path)
	if string(original) != "原文\r\n" {
		t.Fatal("export modified original")
	}
	request, e := o.RequestLatest(s.Key, "owner")
	if e != nil {
		t.Fatal(e)
	}
	saved, e := o.Commit(ctx, s.Key, request.Pending, converted.Candidate)
	if e != nil {
		t.Fatal(e)
	}
	copyRequest, e = o.RequestCopy(s.Key, "owner")
	if e != nil {
		t.Fatal(e)
	}
	if e = o.CopyUnchanged(s.Key, copyRequest.Pending); e != nil {
		t.Fatal(e)
	}
	copyState, _ := o.Get(s.Key)
	data, _ := os.ReadFile(copyState.Candidate)
	if string(data) != "新内容 😀\r\n" || saved.Base == "" {
		t.Fatal("export used initial stale bytes")
	}
}

func TestOfficePreviewCleanupDoesNotInvalidateOtherPreview(t *testing.T) {
	path, _, _ := fixture(t)
	o := NewOffice(New(nil), filepath.Join(t.TempDir(), "office"))
	ctx := context.Background()
	a, err := o.Open(ctx, path, "doc", "view", "main")
	if err != nil {
		t.Fatal(err)
	}
	b, err := o.Open(ctx, path, "doc", "view", "right")
	if err != nil {
		t.Fatal(err)
	}
	if a.Key == b.Key {
		t.Fatal("independently owned previews share cleanup state")
	}
	if err = o.End(a.Key, "main", false); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(a.Initial); !os.IsNotExist(err) {
		t.Fatal("closed preview snapshot not removed", err)
	}
	if _, err = o.InitialPath(b.Key); err != nil {
		t.Fatal("right preview invalidated", err)
	}
	if _, err = os.Stat(b.Initial); err != nil {
		t.Fatal(err)
	}
}

type blockingOfficeNative struct{ entered, release chan struct{} }

func (n blockingOfficeNative) Run(ctx context.Context, op, path, destination string) (string, error) {
	close(n.entered)
	select {
	case <-n.release:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	return destination, os.Rename(path, destination)
}
func TestOfficeCloseCannotReleaseProtectionDuringPhysicalSave(t *testing.T) {
	path, candidate, _ := fixture(t)
	n := blockingOfficeNative{make(chan struct{}), make(chan struct{})}
	store := New(n)
	o := NewOffice(store, filepath.Join(t.TempDir(), "office"))
	s, err := o.Open(context.Background(), path, "doc", "edit", "owner")
	if err != nil {
		t.Fatal(err)
	}
	request, err := o.Request(s.Key, "owner")
	if err != nil {
		t.Fatal(err)
	}
	committed := make(chan error, 1)
	go func() { _, e := o.Commit(context.Background(), s.Key, request.Pending, candidate); committed <- e }()
	<-n.entered
	ended := make(chan error, 1)
	go func() { ended <- o.End(s.Key, "owner", true) }()
	select {
	case e := <-ended:
		t.Fatal("released editor during save", e)
	case <-time.After(20 * time.Millisecond):
	}
	if !errors.Is(store.CheckActive(path), ErrActive) {
		t.Fatal("physical save lost protection")
	}
	close(n.release)
	<-committed
	if e := <-ended; e != nil {
		t.Fatal(e)
	}
	if e := store.CheckActive(path); e != nil {
		t.Fatal("protection not released after save", e)
	}
}
