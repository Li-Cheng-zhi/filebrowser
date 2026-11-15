package web

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	dbsql "github.com/gtsteffaniak/filebrowser/backend/internal/database/sql"
	"github.com/gtsteffaniak/filebrowser/backend/internal/state"
	"github.com/gtsteffaniak/filebrowser/backend/internal/workspace"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/indexing"
	"github.com/gtsteffaniak/filebrowser/backend/pkg/settings"
)

func TestWorksTextDoesNotSilentlyNormalizeUnsupportedLineEndings(t *testing.T) {
	for _, s := range []string{"\ufeff中文 😀\r\n末尾\r\n", "普通\n文本\n", "no final newline"} {
		if ok, _ := worksTextEditable([]byte(s)); !ok {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"mixed\r\nline\n", "old\rmac\r"} {
		if ok, reason := worksTextEditable([]byte(s)); ok || reason == "" {
			t.Fatal(s)
		}
	}
}

func TestWorksTextModesDoNotInheritOfficeImportRestrictions(t *testing.T) {
	for _, ext := range []string{"md", "MD", "txt", "xml", "html", "csv", "json", "ts", "kt"} {
		path := "file." + ext
		if worksOfficeFile(path) {
			t.Fatalf("text %s routed to Office", path)
		}
		if got := worksModes(path, true); !reflect.DeepEqual(got, []string{"view", "edit"}) {
			t.Fatalf("%s modes=%v", path, got)
		}
		if got := worksModes(path, false); !reflect.DeepEqual(got, []string{"view"}) {
			t.Fatalf("read-only %s modes=%v", path, got)
		}
	}
	for _, ext := range []string{"docx", "xlsx", "pptx", "doc", "odt", "xls", "ppt"} {
		if !worksOfficeFile("file." + ext) {
			t.Fatal(ext)
		}
	}
	if got := worksModes("file.docx", true); len(got) > 1 && got[len(got)-1] != "review" {
		t.Fatal(got)
	}
}

// Stream the boundary fixtures instead of allocating a 256 MiB request body.
type worksTextTestReader struct {
	remaining int64
	character byte
}

func (r *worksTextTestReader) Read(buffer []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := len(buffer)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := range buffer[:n] {
		buffer[i] = r.character
	}
	r.remaining -= int64(n)
	return n, nil
}

func TestWorksLargeTextReadSaveAndSaveAs(t *testing.T) {
	previousSettings, previousDB := settings.Config, indexing.GetIndexDB()
	root := setupPutHTTPTest(t)
	runtime := t.TempDir()
	settings.Config.Server.CacheDir = runtime
	if err := os.MkdirAll(filepath.Join(runtime, "sql"), 0755); err != nil {
		t.Fatal(err)
	}
	db, _, err := dbsql.NewIndexDB("works_text", "OFF", 1000, 8, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { settings.Config = previousSettings; indexing.SetIndexDBForTesting(previousDB); _ = db.Close() })
	indexing.SetIndexDBForTesting(db)
	source := settings.Config.Server.NameToSource["Downloads"]
	source.Config.ResolvedRules.IndexingDisabled = true
	indexing.Initialize(source, true, false)
	t.Setenv("WORKS_FILES_RUNTIME", runtime)
	previousFiles, previousOffice := worksFiles, worksOffice
	worksFiles = workspace.New(nil)
	worksOffice = workspace.NewOffice(worksFiles, filepath.Join(runtime, "office"))
	t.Cleanup(func() { worksFiles, worksOffice = previousFiles, previousOffice })
	user, err := state.GetUserByUsername("admin")
	if err != nil {
		t.Fatal(err)
	}
	ctx := &Context{User: &user}
	const size = 65 << 20 // The former 64 MiB gate rejected this file.
	const overSize = (256 << 20) + 1
	path := filepath.Join(root, "projects", "large.txt")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(file, &worksTextTestReader{size, 'x'})
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("fixture: %v %v", err, closeErr)
	}
	version, err := workspace.Version(path)
	if err != nil {
		t.Fatal(err)
	}
	read := httptest.NewRecorder()
	status, err := worksFileGet(read, httptest.NewRequest(http.MethodGet, "/api/works/file?source=Downloads&path=/projects/large.txt", nil), ctx)
	if err != nil || status != http.StatusOK || read.Body.Len() < size || !bytes.Contains(read.Body.Bytes(), []byte(version)) {
		t.Fatalf("large read: status=%d bytes=%d err=%v", status, read.Body.Len(), err)
	}
	read = nil
	request := httptest.NewRequest(http.MethodPut, "/api/resources?source=Downloads&path=/projects/large.txt", &worksTextTestReader{size, 'y'})
	request.Header.Set("If-Match", version)
	status, err = worksPut(httptest.NewRecorder(), request, ctx, "Downloads", "/projects/large.txt", path)
	if err != nil || status != http.StatusOK {
		t.Fatalf("large save: status=%d err=%v", status, err)
	}
	savedVersion, err := workspace.Version(path)
	if err != nil || savedVersion == version {
		t.Fatalf("save did not replace original: %v", err)
	}
	status, err = worksCreate(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/works/file?source=Downloads&path=/projects/copy.txt", &worksTextTestReader{size, 'y'}), ctx)
	copyVersion, versionErr := workspace.Version(filepath.Join(root, "projects", "copy.txt"))
	if err != nil || status != http.StatusOK || versionErr != nil || copyVersion != savedVersion {
		t.Fatalf("large save-as: status=%d err=%v versionErr=%v", status, err, versionErr)
	}
	// Rejected reads use the size before loading bytes. Rejected writes leave both originals untouched.
	over := filepath.Join(root, "projects", "over.txt")
	file, err = os.Create(over)
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(overSize)
	closeErr = file.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("sparse fixture: %v %v", err, closeErr)
	}
	status, err = worksFileGet(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/works/file?source=Downloads&path=/projects/over.txt", nil), ctx)
	if status != http.StatusRequestEntityTooLarge || err == nil || strings.Contains(err.Error(), "下载") {
		t.Fatalf("oversize read: status=%d err=%v", status, err)
	}
	for _, create := range []bool{false, true} {
		body := &worksTextTestReader{overSize, 'z'}
		request = httptest.NewRequest(http.MethodPost, "/api/works/file?source=Downloads&path=/projects/rejected.txt", body)
		if create {
			status, err = worksCreate(httptest.NewRecorder(), request, ctx)
		} else {
			request.Header.Set("If-Match", savedVersion)
			status, err = worksPut(httptest.NewRecorder(), request, ctx, "Downloads", "/projects/large.txt", path)
		}
		if status != http.StatusBadRequest || err == nil {
			t.Fatalf("oversize write create=%v: status=%d err=%v", create, status, err)
		}
	}
	actual, err := workspace.Version(path)
	if err != nil || actual != savedVersion {
		t.Fatalf("rejected save changed the original: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "projects", "rejected.txt")); !os.IsNotExist(err) {
		t.Fatalf("rejected save-as created a file: %v", err)
	}
}
