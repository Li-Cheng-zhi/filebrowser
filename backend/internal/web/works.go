package web

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gtsteffaniak/filebrowser/backend/internal/adapters/fs/files"
	"github.com/gtsteffaniak/filebrowser/backend/internal/utils"
	"github.com/gtsteffaniak/filebrowser/backend/internal/workspace"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/settings"
)

var worksFiles = workspace.New(workspace.NativeCommand{Binary: os.Getenv("WORKS_FILES_NATIVE")})

func worksRuntime() string {
	if value := os.Getenv("WORKS_FILES_RUNTIME"); value != "" {
		return value
	}
	return filepath.Join(settings.Config.Server.CacheDir, "works")
}
func worksEnabled() bool { return os.Getenv("WORKS_FILES_RUNTIME") != "" }

func worksFileGet(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	source, path := r.URL.Query().Get("source"), r.URL.Query().Get("path")
	perms, err := effectiveFilePerms(d, source)
	if err != nil || !perms.View {
		return http.StatusForbidden, fmt.Errorf("无法读取该文件")
	}
	clean, err := utils.SanitizePath(path)
	if err != nil {
		return http.StatusBadRequest, err
	}
	info, err := files.FileInfoFaster(utils.FileOptions{Source: source, Path: clean, FollowSymlinks: true}, d.User)
	if err != nil {
		return ErrToStatus(err), err
	}
	canonical, err := workspace.Canonical(info.RealPath)
	if err != nil {
		return ErrToStatus(err), err
	}
	if r.URL.Query().Get("metadata") == "true" {
		return RenderJSON(w, r, map[string]any{"canonicalPath": canonical, "source": source, "path": clean, "type": info.Type})
	}
	file, err := os.Open(canonical)
	if err != nil {
		return ErrToStatus(err), err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return ErrToStatus(err), err
	}
	if !stat.Mode().IsRegular() {
		return http.StatusBadRequest, fmt.Errorf("文本读取目标不是普通文件")
	}
	const maxText = 64 << 20
	data, err := io.ReadAll(io.LimitReader(file, maxText+1))
	if err != nil {
		return ErrToStatus(err), err
	}
	if len(data) > maxText {
		return http.StatusRequestEntityTooLarge, fmt.Errorf("Monaco 文本编辑上限为 64 MiB；文件未截断，可使用下载")
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00') {
		return http.StatusUnsupportedMediaType, fmt.Errorf("当前仅无损编辑 UTF-8 文本，原文件未修改")
	}
	hash := sha256.Sum256(data)
	return RenderJSON(w, r, map[string]any{"canonicalPath": canonical, "source": source, "path": clean, "version": hex.EncodeToString(hash[:]), "text": string(data), "bytes": len(data), "encoding": "utf-8"})
}

func worksResolve(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	canonical, err := workspace.Canonical(r.URL.Query().Get("absolutePath"))
	if err != nil {
		return ErrToStatus(err), err
	}
	bestName, bestRoot := "", ""
	for _, source := range settings.Config.Server.Sources {
		root, e := workspace.Canonical(source.Path)
		if e != nil {
			continue
		}
		if (canonical == root || strings.HasPrefix(canonical, root+string(filepath.Separator))) && len(root) > len(bestRoot) {
			bestName, bestRoot = source.Name, root
		}
	}
	if bestRoot == "" {
		return http.StatusNotFound, fmt.Errorf("工作区不在已配置的 Quantum source 内")
	}
	query := *r.URL
	values := query.Query()
	relative, _ := filepath.Rel(bestRoot, canonical)
	if relative == "." {
		relative = ""
	}
	values.Set("source", bestName)
	values.Set("path", "/"+filepath.ToSlash(relative))
	values.Set("metadata", "true")
	query.RawQuery = values.Encode()
	copy := r.Clone(r.Context())
	copy.URL = &query
	return worksFileGet(w, copy, d)
}

// The legacy upload/create API is unchanged. Editing an existing file in Works
// uses a raw body and explicit baseline; no second filesystem backend is added.
func worksPut(w http.ResponseWriter, r *http.Request, d *Context, source, indexPath, path string) (int, error) {
	expected := strings.Trim(r.Header.Get("If-Match"), "\"")
	if expected == "" {
		return RenderJSON(w, r, map[string]any{"code": "BASE_VERSION_REQUIRED", "message": "保存必须携带读取结果的 If-Match 内容版本"}, http.StatusPreconditionRequired)
	}
	dir := filepath.Join(os.Getenv("WORKS_FILES_RUNTIME"), "drafts")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return http.StatusInternalServerError, err
	}
	candidate, err := os.CreateTemp(dir, "text-*")
	if err != nil {
		return http.StatusInternalServerError, err
	}
	name := candidate.Name()
	_, copyErr := io.Copy(candidate, http.MaxBytesReader(w, r.Body, 64<<20))
	closeErr := candidate.Close()
	if copyErr != nil {
		_ = os.Remove(name)
		return http.StatusBadRequest, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(name)
		return http.StatusInternalServerError, closeErr
	}
	stat, err := os.Stat(name)
	if err != nil {
		_ = os.Remove(name)
		return http.StatusInternalServerError, err
	}
	quotaCtx := uploadQuotaContext(d, source, indexPath, path, r, newQuotaSessionID(), stat.Size(), true)
	if quotaErr := checkUploadQuota(quotaCtx); quotaErr != nil {
		_ = os.Remove(name)
		return renderQuotaError(w, r, quotaErr)
	}
	defer releaseUploadQuota(quotaCtx.SessionID)
	version, err := worksFiles.Save(r.Context(), path, expected, name, "")
	if err != nil {
		var conflict *workspace.Conflict
		if errors.As(err, &conflict) {
			return RenderJSON(w, r, map[string]any{"code": "FILE_CHANGED", "message": err.Error(), "actualVersion": conflict.Actual, "absent": conflict.Absent, "draft": filepath.Base(name), "actions": []string{"keep", "reload", "overwrite", "saveAs"}}, http.StatusConflict)
		}
		_ = os.Remove(name)
		if errors.Is(err, workspace.ErrActive) {
			return http.StatusConflict, err
		}
		return http.StatusInternalServerError, err
	}
	_ = os.Remove(name)
	if err = commitUploadQuotaAfterMove(quotaCtx); err != nil {
		return http.StatusInternalServerError, err
	}
	w.Header().Set("ETag", "\""+version+"\"")
	return RenderJSON(w, r, map[string]any{"version": version, "canonicalPath": path, "saved": true})
}
