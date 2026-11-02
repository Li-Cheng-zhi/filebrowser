package web

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestOfficeConversionCannotChangeTargetFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "converted")
	file, _ := os.Create(path)
	z := zip.NewWriter(file)
	entry, _ := z.Create("xl/workbook.xml")
	_, _ = entry.Write([]byte("<workbook/>"))
	_ = z.Close()
	_ = file.Close()
	if e := worksValidateOfficeOutput("target.xlsx", path); e != nil {
		t.Fatal(e)
	}
	if e := worksValidateOfficeOutput("target.docx", path); e == nil {
		t.Fatal("would replace DOCX with XLSX bytes")
	}
	_ = os.WriteFile(path, []byte("broken conversion"), 0600)
	if e := worksValidateOfficeOutput("target.xlsx", path); e == nil {
		t.Fatal("incomplete conversion accepted")
	}
}
