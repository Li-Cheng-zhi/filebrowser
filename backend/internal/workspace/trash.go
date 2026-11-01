package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var ErrRestoreParent = errors.New("原父目录不存在，请确认是否重建")
var ErrRestoreExists = errors.New("恢复目标已存在，请换名恢复或取消")

type TrashRecord struct {
	Version   int       `json:"version"`
	ID        string    `json:"id"`
	Source    string    `json:"source"`
	Original  string    `json:"originalPath"`
	Recycled  string    `json:"recycledPath,omitempty"`
	DeletedAt time.Time `json:"deletedAt"`
	Directory bool      `json:"directory"`
	State     string    `json:"state"`
	Failure   string    `json:"failure,omitempty"`
}
type Trash struct {
	Files *Store
	Root  string
}

func (t *Trash) write(r TrashRecord) error {
	if err := os.MkdirAll(t.Root, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(t.Root, ".record-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(t.Root, r.ID+".json"))
}
func (t *Trash) Delete(ctx context.Context, source, path string) (TrashRecord, error) {
	unlock, err := t.Files.Lock(ctx)
	if err != nil {
		return TrashRecord{}, err
	}
	defer unlock()
	// Resolve parents, not the final symlink: deleting an alias must never trash its target.
	path, err = Destination(path)
	if err != nil {
		return TrashRecord{}, err
	}
	if err = t.Files.CheckActive(path); err != nil {
		return TrashRecord{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return TrashRecord{}, err
	}
	if t.Files.Native == nil {
		return TrashRecord{}, errors.New("未配置系统回收站")
	}
	var raw [16]byte
	if _, err = rand.Read(raw[:]); err != nil {
		return TrashRecord{}, err
	}
	r := TrashRecord{Version: 1, ID: hex.EncodeToString(raw[:]), Source: source, Original: path, DeletedAt: time.Now().UTC(), Directory: info.IsDir(), State: "pending"}
	if err = t.write(r); err != nil {
		return r, err
	}
	r.Recycled, err = t.Files.Native.Run(ctx, "trash", path, "")
	if err != nil {
		r.State = "failed"
		r.Failure = err.Error()
		_ = t.write(r)
		return r, err
	}
	r.State = "trashed"
	if err = t.write(r); err != nil {
		return r, err
	}
	return r, nil
}
func (t *Trash) Get(id string) (TrashRecord, error) {
	if len(id) != 32 || strings.Trim(id, "0123456789abcdef") != "" {
		return TrashRecord{}, errors.New("无效回收记录")
	}
	data, err := os.ReadFile(filepath.Join(t.Root, id+".json"))
	if err != nil {
		return TrashRecord{}, err
	}
	var r TrashRecord
	err = json.Unmarshal(data, &r)
	return r, err
}
func (t *Trash) List() ([]TrashRecord, error) {
	entries, err := os.ReadDir(t.Root)
	if os.IsNotExist(err) {
		return []TrashRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []TrashRecord{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		r, e := t.Get(strings.TrimSuffix(entry.Name(), ".json"))
		if e != nil {
			continue
		}
		if r.State == "trashed" {
			if _, e = os.Lstat(r.Recycled); os.IsNotExist(e) {
				_ = os.Remove(filepath.Join(t.Root, entry.Name()))
				continue
			}
		}
		if r.State != "restored" {
			out = append(out, r)
		}
	}
	return out, nil
}
func (t *Trash) Restore(ctx context.Context, id, destination string, createParents bool) (TrashRecord, error) {
	unlock, err := t.Files.Lock(ctx)
	if err != nil {
		return TrashRecord{}, err
	}
	defer unlock()
	r, err := t.Get(id)
	if err != nil {
		return r, err
	}
	if r.State != "trashed" {
		return r, errors.New("该回收记录不可恢复")
	}
	if destination == "" {
		destination = r.Original
	}
	if _, err = os.Lstat(destination); err == nil {
		return r, ErrRestoreExists
	} else if !os.IsNotExist(err) {
		return r, err
	}
	if _, err = os.Stat(filepath.Dir(destination)); os.IsNotExist(err) {
		if !createParents {
			return r, ErrRestoreParent
		}
		if err = os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			return r, err
		}
	} else if err != nil {
		return r, err
	}
	if err = t.Files.CheckActive(destination); err != nil {
		return r, err
	}
	if _, err = t.Files.Native.Run(ctx, "restore", r.Recycled, destination); err != nil {
		return r, err
	}
	r.State = "restored"
	return r, t.write(r)
}
