package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gtsteffaniak/filebrowser/backend/internal/adapters/fs/files"
	"github.com/gtsteffaniak/filebrowser/backend/internal/utils"
	"github.com/gtsteffaniak/filebrowser/backend/internal/workspace"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/indexing"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/settings"
)

var worksPages = workspace.NewPages()
var worksTrash = &workspace.Trash{Files: worksFiles, Root: filepath.Join(worksRuntime(), "trash")}

func init() {
	if worksEnabled() {
		files.TrashEntry = func(source, path string) error {
			_, err := worksTrash.Delete(context.Background(), source, path)
			return err
		}
	}
}

func worksDirectoryGet(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	source, path := r.URL.Query().Get("source"), r.URL.Query().Get("path")
	clean, err := utils.SanitizePath(path)
	if err != nil {
		return http.StatusBadRequest, err
	}
	perms, err := effectiveFilePerms(d, source)
	if err != nil || !perms.View {
		return http.StatusForbidden, fmt.Errorf("无法浏览该目录")
	}
	limit := 200
	if raw := r.URL.Query().Get("pageSize"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			return http.StatusBadRequest, fmt.Errorf("pageSize 必须为 1—1000 的整数")
		}
	}
	order := r.URL.Query().Get("order")
	if order == "" {
		order = "name"
	}
	switch order {
	case "name", "size", "modified", "created", "kind", "duration":
	default:
		return http.StatusBadRequest, fmt.Errorf("order 仅接受 name、size、modified、created、kind、duration")
	}
	ascending := r.URL.Query().Get("descending") != "true"
	key := d.User.Username + "\x00" + source + "\x00" + clean + "\x00" + order + fmt.Sprint(ascending)
	var page workspace.Page
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		page, err = worksPages.Next(key, cursor, limit)
	} else {
		// Reuse upstream permission checks, metadata shape and view grants. Only
		// the immutable paging slice is new; there is no second filesystem reader.
		copy := r.Clone(r.Context())
		copy.Header = r.Header.Clone()
		copy.Header.Del("Accept-Encoding")
		urlCopy := *r.URL
		q := urlCopy.Query()
		q.Set("path", clean)
		q.Del("content")
		q.Del("metadata")
		urlCopy.RawQuery = q.Encode()
		copy.URL = &urlCopy
		recorder := newWorksResponseBuffer()
		status, e := resourceGetHandler(recorder, copy, d)
		if e != nil {
			return status, e
		}
		var meta map[string]json.RawMessage
		if e = json.Unmarshal(recorder.body.Bytes(), &meta); e != nil {
			return http.StatusInternalServerError, e
		}
		var kind string
		_ = json.Unmarshal(meta["type"], &kind)
		if kind != "directory" {
			return http.StatusBadRequest, fmt.Errorf("目标不是目录")
		}
		var folders, files []json.RawMessage
		_ = json.Unmarshal(meta["folders"], &folders)
		_ = json.Unmarshal(meta["files"], &files)
		delete(meta, "folders")
		delete(meta, "files")
		page, err = worksPages.CreateOrder(key, append(folders, files...), meta, limit, order, ascending)
	}
	if err != nil {
		if errors.Is(err, workspace.ErrPageExpired) {
			return RenderJSON(w, r, map[string]any{"code": "DIRECTORY_REFRESH_REQUIRED", "message": err.Error()}, http.StatusGone)
		}
		return http.StatusBadRequest, err
	}
	out := make(map[string]any)
	for k, v := range page.Meta {
		out[k] = v
	}
	folders, files := []json.RawMessage{}, []json.RawMessage{}
	for _, raw := range page.Items {
		var item struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &item)
		if item.Type == "directory" {
			folders = append(folders, raw)
		} else {
			files = append(files, raw)
		}
	}
	out["folders"], out["files"] = folders, files
	out["page"] = map[string]any{"nextCursor": page.Next, "total": page.Total, "complete": page.Next == ""}
	return RenderJSON(w, r, out)
}

func worksTrashGet(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	if !worksEnabled() {
		return http.StatusNotImplemented, fmt.Errorf("系统回收站未配置")
	}
	list, err := worksTrash.List()
	if err != nil {
		return http.StatusInternalServerError, err
	}
	visible := []workspace.TrashRecord{}
	for _, item := range list {
		perms, e := effectiveFilePerms(d, item.Source)
		if e == nil && perms.View {
			visible = append(visible, item)
		}
	}
	return RenderJSON(w, r, visible)
}
func worksTrashRestore(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	if !worksEnabled() {
		return http.StatusNotImplemented, fmt.Errorf("系统回收站未配置")
	}
	var input struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		CreateParents bool   `json:"createParents"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&input); err != nil {
		return http.StatusBadRequest, err
	}
	record, err := worksTrash.Get(input.ID)
	if err != nil {
		return http.StatusNotFound, err
	}
	perms, err := effectiveFilePerms(d, record.Source)
	if err != nil || !perms.Create {
		return http.StatusForbidden, fmt.Errorf("该 source 不可恢复文件")
	}
	destination := record.Original
	if input.Name != "" {
		if filepath.Base(input.Name) != input.Name || input.Name == "." || input.Name == ".." {
			return http.StatusBadRequest, fmt.Errorf("恢复名称必须是一个文件名")
		}
		destination = filepath.Join(filepath.Dir(destination), input.Name)
	}
	source, ok := settings.Config.Server.NameToSource[record.Source]
	if !ok {
		return http.StatusNotFound, fmt.Errorf("source 已移除")
	}
	root, err := workspace.Canonical(source.Path)
	if err != nil {
		return http.StatusNotFound, err
	}
	relative, err := filepath.Rel(root, destination)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return http.StatusBadRequest, fmt.Errorf("恢复路径不在原 source 内")
	}
	idx := indexing.GetIndex(record.Source)
	scope, err := d.User.GetScopeForSourceName(record.Source)
	if err != nil || idx == nil {
		return http.StatusForbidden, fmt.Errorf("source 不可用")
	}
	if _, err = idx.GetRealPathForMutation(scope, "/"+filepath.ToSlash(relative)); err != nil {
		return http.StatusForbidden, err
	}
	restored, err := worksTrash.Restore(r.Context(), input.ID, destination, input.CreateParents)
	if err != nil {
		code := "RESTORE_FAILED"
		if errors.Is(err, workspace.ErrRestoreParent) {
			code = "RESTORE_PARENT_CONFIRMATION"
		}
		if errors.Is(err, workspace.ErrRestoreExists) {
			code = "RESTORE_NAME_CONFLICT"
		}
		return RenderJSON(w, r, map[string]any{"code": code, "message": err.Error()}, http.StatusConflict)
	}
	_ = files.RefreshIndex(record.Source, "/"+filepath.ToSlash(filepath.Dir(relative)), true, false)
	return RenderJSON(w, r, restored)
}

type worksResponseBuffer struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newWorksResponseBuffer() *worksResponseBuffer {
	return &worksResponseBuffer{header: make(http.Header)}
}
func (b *worksResponseBuffer) Header() http.Header            { return b.header }
func (b *worksResponseBuffer) WriteHeader(status int)         { b.status = status }
func (b *worksResponseBuffer) Write(data []byte) (int, error) { return b.body.Write(data) }
