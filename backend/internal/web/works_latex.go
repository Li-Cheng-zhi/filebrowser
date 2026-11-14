package web

// OpenLeaf wiring uses the existing Works source resolution and file APIs.
// Baseline: FileBrowser 876200c0/internal/web/works.go and vite_proxy.go.
import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/gtsteffaniak/filebrowser/backend/internal/adapters/fs/files"
	"github.com/gtsteffaniak/filebrowser/backend/internal/utils"
	"github.com/gtsteffaniak/filebrowser/backend/internal/workspace"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/settings"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
)

func worksLatexProxy(api bool) http.Handler {
	target, _ := url.Parse("http://127.0.0.1:18083")
	return &httputil.ReverseProxy{FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		prefix := ""
		if api {
			prefix = "/api"
		}
		pr.Out.URL.Path = prefix + strings.TrimPrefix(pr.In.URL.Path, "/works/latex")
		pr.Out.URL.RawPath = ""
		pr.Out.Header.Del("Authorization")
		pr.Out.Header.Del("Cookie")
	}}
}

func worksLatexAPI(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	worksLatexProxy(true).ServeHTTP(w, r)
	return 0, nil
}
func worksLatexPage(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	worksLatexProxy(false).ServeHTTP(w, r)
	return 0, nil
}

func worksLatexOpen(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	var input struct {
		Source   string `json:"source"`
		Path     string `json:"path"`
		Root     string `json:"root"`
		MainFile string `json:"mainFile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		return http.StatusBadRequest, err
	}
	perms, err := effectiveFilePerms(d, input.Source)
	if err != nil || !perms.View {
		return http.StatusForbidden, fmt.Errorf("无法打开此工程")
	}
	source, ok := settings.Config.Server.NameToSource[input.Source]
	if !ok {
		return http.StatusBadRequest, fmt.Errorf("文件来源不存在")
	}
	clean, err := utils.SanitizePath(input.Path)
	if err != nil {
		return http.StatusBadRequest, err
	}
	info, err := files.FileInfoFaster(utils.FileOptions{Source: input.Source, Path: clean, FollowSymlinks: true}, d.User)
	if err != nil {
		return ErrToStatus(err), err
	}
	initial, err := workspace.Canonical(info.RealPath)
	if err != nil {
		return ErrToStatus(err), err
	}
	if !strings.EqualFold(filepath.Ext(initial), ".tex") {
		return http.StatusBadRequest, fmt.Errorf("此入口仅处理 LaTeX 文件")
	}
	sourceRoot, err := workspace.Canonical(source.Path)
	if err != nil {
		return ErrToStatus(err), err
	}
	root := filepath.Dir(initial)
	if input.Root != "" {
		index := input.Root
		if index == sourceRoot {
			index = "/"
		} else if strings.HasPrefix(index, sourceRoot+string(filepath.Separator)) {
			index = strings.TrimPrefix(index, sourceRoot)
		}
		index, err = utils.SanitizePath(index)
		if err != nil {
			return http.StatusBadRequest, err
		}
		folder, e := files.FileInfoFaster(utils.FileOptions{Source: input.Source, Path: index, FollowSymlinks: true}, d.User)
		if e != nil {
			return ErrToStatus(e), e
		}
		if folder.Type != "directory" {
			return http.StatusBadRequest, fmt.Errorf("所选工程根必须是目录")
		}
		root, err = workspace.Canonical(folder.RealPath)
		if err != nil {
			return ErrToStatus(err), err
		}
	}
	payload, err := json.Marshal(map[string]any{"source": input.Source, "sourceRoot": sourceRoot, "root": root,
		"initialFile": initial, "explicitRoot": input.Root != "", "mainFile": input.MainFile})
	if err != nil {
		return http.StatusBadRequest, err
	}
	r.Body = http.NoBody
	r.ContentLength = int64(len(payload))
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(bytes.NewReader(payload))
	worksLatexProxy(true).ServeHTTP(w, r)
	return 0, nil
}
