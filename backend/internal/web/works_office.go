package web

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	jwt "github.com/golang-jwt/jwt/v4"
	"github.com/gtsteffaniak/filebrowser/backend/internal/workspace"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/settings"
)

var worksOffice = workspace.NewOffice(worksFiles, filepath.Join(worksRuntime(), "office"))

func worksOfficeConfig(r *http.Request, config map[string]interface{}, path string) error {
	document := config["document"].(map[string]interface{})
	editor := config["editorConfig"].(map[string]interface{})
	permissions := document["permissions"].(map[string]interface{})
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "view"
	}
	if mode != "view" && mode != "edit" && mode != "review" {
		return fmt.Errorf("mode 仅接受 view、edit、review")
	}
	fileType, _ := document["fileType"].(string)
	if mode == "review" && fileType != "docx" && fileType != "docm" && fileType != "doc" && fileType != "odt" {
		return fmt.Errorf("该格式不支持正文修订审阅，可用模式为 view、edit")
	}
	if mode != "view" && fileType != "docx" && fileType != "xlsx" && fileType != "pptx" {
		return fmt.Errorf("本次无损回写仅支持 DOCX、XLSX、PPTX；该格式可预览或另存原文件")
	}
	if mode != "view" && (editor["mode"] != "edit" || !worksSourceWritable(r.URL.Query().Get("source"))) {
		return fmt.Errorf("该文件不可编辑")
	}
	owner := r.URL.Query().Get("owner")
	if mode != "view" && owner == "" {
		return fmt.Errorf("可写 Office 会话需要页面 owner")
	}
	key := document["key"].(string)
	session, err := worksOffice.Open(r.Context(), path, key, mode, owner)
	if err != nil {
		return err
	}
	if err = worksOffice.Bind(session.Key, r.URL.Query().Get("source"), r.URL.Query().Get("path")); err != nil {
		_ = worksOffice.End(session.Key, owner, true)
		return err
	}
	document["key"] = session.Key
	query := url.Values{"key": {session.Key}}
	document["url"] = onlyOfficeFileBrowserBaseURL(r) + "api/works/office/initial?" + query.Encode()
	permissions["edit"] = mode == "edit"
	permissions["review"] = mode == "review"
	permissions["comment"] = mode != "view"
	permissions["fillForms"] = mode == "edit"
	editor["mode"] = "view"
	if mode != "view" {
		editor["mode"] = "edit"
	}
	editor["lang"] = "zh"
	editor["coEditing"] = map[string]any{"mode": "fast", "change": false}
	custom := editor["customization"].(map[string]interface{})
	custom["autosave"] = true
	// Client autosave submits deltas. Physical saves use command userdata so
	// results can be associated; disable uncorrelated native toolbar force-save.
	custom["forcesave"] = false
	custom["review"] = map[string]any{"trackChanges": mode == "review"}
	config["works"] = map[string]any{"key": session.Key, "version": session.Base, "mode": mode, "canonicalPath": session.Path}
	return nil
}

func worksOfficeInitial(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	path, err := worksOffice.InitialPath(r.URL.Query().Get("key"))
	if err != nil {
		return http.StatusNotFound, err
	}
	f, err := os.Open(path)
	if err != nil {
		return http.StatusNotFound, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return http.StatusInternalServerError, err
	}
	http.ServeContent(w, r, "document", info.ModTime(), f)
	return 0, nil
}
func worksOfficeStatus(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	state, err := worksOffice.Get(r.URL.Query().Get("key"))
	if err != nil {
		return http.StatusNotFound, err
	}
	actual, statErr := workspace.Version(state.Path)
	absent := os.IsNotExist(statErr)
	return RenderJSON(w, r, map[string]any{"session": state, "actualVersion": actual, "absent": absent})
}
func worksOfficeCommand(w http.ResponseWriter, r *http.Request, d *Context) (int, error) {
	var input struct {
		Source   string `json:"source"`
		Path     string `json:"path"`
		Key      string `json:"key"`
		Owner    string `json:"owner"`
		Action   string `json:"action"`
		Expected string `json:"expectedVersion"`
		Discard  bool   `json:"discard"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&input); err != nil {
		return http.StatusBadRequest, err
	}
	session, err := worksOffice.Get(input.Key)
	if err != nil {
		return http.StatusNotFound, err
	}
	if input.Action == "saveAs" {
		if (session.Mode != "view" && session.Owner != input.Owner) || (session.Mode != "view" && session.Candidate == "") {
			return http.StatusConflict, errors.New("当前没有可另存的转换结果，请先完成保存转换")
		}
		if !strings.EqualFold(filepath.Ext(input.Path), filepath.Ext(session.Path)) {
			return http.StatusBadRequest, errors.New("另存名称必须保留原 Office 扩展名")
		}
		real, indexPath, e := worksDestination(d, input.Source, input.Path)
		if e != nil {
			return http.StatusBadRequest, e
		}
		copy := r.Clone(r.Context())
		u := *r.URL
		q := u.Query()
		q.Set("path", input.Path)
		u.RawQuery = q.Encode()
		copy.URL = &u
		candidate := session.Candidate
		if session.Mode == "view" {
			candidate = session.Initial
		}
		return worksPublish(w, copy, d, input.Source, indexPath, real, candidate)
	}
	if input.Action == "end" {
		if err = worksOffice.End(input.Key, input.Owner, input.Discard); err != nil {
			return http.StatusConflict, err
		}
		return RenderJSON(w, r, map[string]bool{"closed": true})
	}
	if input.Action == "overwrite" {
		state, e := worksOffice.Resolve(r.Context(), input.Key, input.Owner, input.Expected)
		if e != nil {
			return http.StatusConflict, e
		}
		return RenderJSON(w, r, state)
	}
	if input.Action != "save" && input.Action != "convert" && input.Action != "convertOnly" {
		return http.StatusBadRequest, fmt.Errorf("action 仅接受 save、convert、overwrite、saveAs、end")
	}
	if session.Owner != input.Owner {
		return http.StatusConflict, errors.New("Office 页面归属不匹配")
	}
	if session.Pending != "" {
		return RenderJSON(w, r, session)
	}
	if input.Action == "convertOnly" {
		session, err = worksOffice.RequestCopy(input.Key, input.Owner)
	} else if input.Action == "convert" {
		session, err = worksOffice.RequestLatest(input.Key, input.Owner)
	} else {
		session, err = worksOffice.Request(input.Key, input.Owner)
	}
	if err != nil {
		return http.StatusConflict, err
	}
	command := map[string]any{"c": "forcesave", "key": session.Key, "userdata": session.Pending}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims(command))
	signed, err := token.SignedString([]byte(settings.Config.Integrations.OnlyOffice.Secret))
	if err != nil {
		return http.StatusInternalServerError, err
	}
	command["token"] = signed
	data, _ := json.Marshal(command)
	endpoint := settings.Config.Integrations.OnlyOffice.InternalUrl
	if endpoint == "" {
		endpoint = settings.Config.Integrations.OnlyOffice.Url
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimRight(endpoint, "/")+"/command", bytes.NewReader(data))
	if err != nil {
		return http.StatusInternalServerError, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := onlyOfficeDownloadClient.Do(request)
	if err != nil {
		worksOffice.Fail(input.Key, err.Error())
		return http.StatusBadGateway, err
	}
	defer response.Body.Close()
	var result struct {
		Error int `json:"error"`
	}
	if response.StatusCode != 200 {
		worksOffice.Fail(input.Key, fmt.Sprintf("保存命令 HTTP %d", response.StatusCode))
		return http.StatusBadGateway, fmt.Errorf("文档服务器命令失败：HTTP %d", response.StatusCode)
	}
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		worksOffice.Fail(input.Key, err.Error())
		return http.StatusBadGateway, err
	}
	if result.Error == 4 {
		if session.Purpose == "copy" {
			if err = worksOffice.CopyUnchanged(input.Key, session.Pending); err != nil {
				worksOffice.Fail(input.Key, err.Error())
				return http.StatusInternalServerError, err
			}
		} else if session.Candidate != "" {
			if _, err = worksOffice.Commit(r.Context(), input.Key, session.Pending, session.Candidate); err != nil {
				return http.StatusConflict, err
			}
		} else {
			actual, e := workspace.Version(session.Path)
			if e != nil || actual != session.Base {
				worksOffice.Fail(input.Key, "磁盘版本已变化，请重新载入或另存")
				return http.StatusConflict, errors.New("磁盘版本已变化，未覆盖原文件")
			}
			worksOffice.NoChanges(input.Key, session.Pending)
		}
	} else if result.Error != 0 {
		message := fmt.Sprintf("文档服务器保存命令失败：%d", result.Error)
		worksOffice.Fail(input.Key, message)
		return http.StatusBadGateway, errors.New(message)
	}
	state, _ := worksOffice.Get(input.Key)
	return RenderJSON(w, r, state)
}

func worksOfficeCommit(w http.ResponseWriter, r *http.Request, data *OnlyOfficeCallback, body io.Reader) (int, error) {
	candidate, err := worksOffice.CandidatePath()
	if err != nil {
		return http.StatusInternalServerError, err
	}
	name := candidate.Name()
	_, copyErr := io.Copy(candidate, body)
	closeErr := candidate.Close()
	if copyErr != nil {
		return http.StatusBadGateway, copyErr
	}
	if closeErr != nil {
		return http.StatusInternalServerError, closeErr
	}
	if session, e := worksOffice.Get(data.Key); e == nil {
		if e = worksValidateOfficeOutput(session.Path, name); e != nil {
			worksOffice.RetainFailed(data.Key, name, e.Error())
			return returnOnlyOfficeError(w, r, http.StatusConflict, e.Error())
		}
	}
	_, err = worksOffice.Commit(r.Context(), data.Key, data.UserData, name)
	if data.Status == onlyOfficeStatusDocumentClosedWithChanges {
		// A crashed/disconnected editor has no host request to associate. Keep
		// its complete converted candidate, then release the in-memory activity
		// guard when the document server confirms every editor has left.
		if session, e := worksOffice.Get(data.Key); e == nil {
			_ = worksOffice.End(data.Key, session.Owner, true)
		}
		if errors.Is(err, workspace.ErrUnassociated) {
			return returnOnlyOfficeSuccess(w, r)
		}
	}
	if err != nil {
		return returnOnlyOfficeError(w, r, http.StatusConflict, err.Error())
	}
	return returnOnlyOfficeSuccess(w, r)
}

func worksValidateOfficeOutput(original, candidate string) error {
	required := map[string]string{".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}[strings.ToLower(filepath.Ext(original))]
	if required == "" {
		return errors.New("未启用该格式的原路径回写")
	}
	archive, err := zip.OpenReader(candidate)
	if err != nil {
		return errors.New("文档转换结果不完整或不是 OOXML，原文件未修改")
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if entry.Name == required {
			reader, e := entry.Open()
			if e != nil {
				return e
			}
			_, e = io.Copy(io.Discard, reader)
			_ = reader.Close()
			return e
		}
	}
	return errors.New("文档转换格式与原扩展名不一致，原文件未修改")
}
