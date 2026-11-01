package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeTrash struct{ directory string }

func (f fakeTrash) Run(_ context.Context, operation, path, destination string) (string, error) {
	if operation == "trash" {
		destination = filepath.Join(f.directory, filepath.Base(path))
	}
	return destination, os.Rename(path, destination)
}
func TestTrashRestoreCollisionMissingParentAndSystemRemoval(t *testing.T) {
	dir := t.TempDir()
	recycle := filepath.Join(dir, "system-trash")
	_ = os.Mkdir(recycle, 0700)
	folder := filepath.Join(dir, "original")
	_ = os.Mkdir(folder, 0700)
	path := filepath.Join(folder, "文档")
	_ = os.WriteFile(path, []byte("keep"), 0600)
	trash := &Trash{Files: New(fakeTrash{recycle}), Root: filepath.Join(dir, "records")}
	r, e := trash.Delete(context.Background(), "source", path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("original still present")
	}
	_ = os.WriteFile(path, []byte("new occupant"), 0600)
	if _, e = trash.Restore(context.Background(), r.ID, "", false); !errors.Is(e, ErrRestoreExists) {
		t.Fatal(e)
	}
	_ = os.Remove(path)
	_ = os.Remove(folder)
	if _, e = trash.Restore(context.Background(), r.ID, "", false); !errors.Is(e, ErrRestoreParent) {
		t.Fatal(e)
	}
	if _, e = trash.Restore(context.Background(), r.ID, "", true); e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "keep" {
		t.Fatal("restore lost bytes")
	}
	r, e = trash.Delete(context.Background(), "source", path)
	if e != nil {
		t.Fatal(e)
	}
	_ = os.Remove(r.Recycled)
	list, e := trash.List()
	if e != nil || len(list) != 0 {
		t.Fatalf("stale records %v %v", list, e)
	}
}
func TestTrashDeletesSymlinkNotTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "link")
	_ = os.WriteFile(target, []byte("keep"), 0600)
	_ = os.Symlink(target, link)
	recycle := filepath.Join(dir, "trash")
	_ = os.Mkdir(recycle, 0700)
	trash := &Trash{Files: New(fakeTrash{recycle}), Root: filepath.Join(dir, "records")}
	if _, e := trash.Delete(context.Background(), "s", link); e != nil {
		t.Fatal(e)
	}
	if data, e := os.ReadFile(target); e != nil || string(data) != "keep" {
		t.Fatal("symlink target was trashed")
	}
}
