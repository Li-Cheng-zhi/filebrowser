package web

import (
	"reflect"
	"testing"
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
