package web

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gtsteffaniak/filebrowser/backend/internal/adapters/fs/files"
	"github.com/gtsteffaniak/filebrowser/backend/internal/utils"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/indexing"
)

func worksDestination(d *Context, source, path string) (string, string, error) {
	if status, e := denyIfSourceReadOnly(source); e != nil {
		return "", "", fmt.Errorf("%d: %w", status, e)
	}
	perms, e := effectiveFilePerms(d, source)
	if e != nil || !perms.Create {
		return "", "", errors.New("目标目录不可新建文件")
	}
	clean, e := utils.SanitizePath(path)
	if e != nil {
		return "", "", e
	}
	scope, e := d.User.GetScopeForSourceName(source)
	if e != nil {
		return "", "", e
	}
	idx := indexing.GetIndex(source)
	if idx == nil {
		return "", "", errors.New("source 不存在")
	}
	indexPath := utils.JoinScopedIndexPath(scope, clean)
	real, e := idx.GetRealPathForMutation(scope, indexPath)
	return real, indexPath, e
}
func worksCreate(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	if !worksEnabled() {
		return http.StatusNotImplemented, errors.New("Works 文件服务未启用")
	}
	source, path := r.URL.Query().Get("source"), r.URL.Query().Get("path")
	real, indexPath, e := worksDestination(d, source, path)
	if e != nil {
		return http.StatusBadRequest, e
	}
	temp, e := worksOffice.CandidatePath()
	if e != nil {
		return http.StatusInternalServerError, e
	}
	defer os.Remove(temp.Name())
	_, e = io.Copy(temp, http.MaxBytesReader(w, r.Body, 64<<20))
	closeErr := temp.Close()
	if e != nil {
		return http.StatusBadRequest, e
	}
	if closeErr != nil {
		return http.StatusInternalServerError, closeErr
	}
	return worksPublish(w, r, d, source, indexPath, real, temp.Name())
}
func worksPublish(w http.ResponseWriter, r *http.Request, d *Context, source, indexPath, real, candidate string) (int, error) {
	stat, e := os.Stat(candidate)
	if e != nil {
		return http.StatusNotFound, e
	}
	quotaCtx := uploadQuotaContext(d, source, indexPath, real, r, newQuotaSessionID(), stat.Size(), true)
	if e = checkUploadQuota(quotaCtx); e != nil {
		return renderQuotaError(w, r, e)
	}
	defer releaseUploadQuota(quotaCtx.SessionID)
	version, e := worksFiles.Create(r.Context(), real, candidate)
	if e != nil {
		if os.IsExist(e) {
			return http.StatusConflict, errors.New("目标名称已存在，请换一个名称")
		}
		return http.StatusConflict, e
	}
	if e = commitUploadQuotaAfterMove(quotaCtx); e != nil {
		return http.StatusInternalServerError, e
	}
	_ = files.RefreshIndex(source, filepath.Dir(indexPath), true, false)
	return RenderJSON(w, r, map[string]any{"saved": true, "version": version, "canonicalPath": real, "source": source, "path": r.URL.Query().Get("path")})
}
