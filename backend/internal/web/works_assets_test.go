package web

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestWorksAssetsKeepOldLazyChunksAndRejectTraversal(t *testing.T) {
	previous := assetFs
	assetFs = fstest.MapFS{}
	t.Cleanup(func() { assetFs = previous })
	root := t.TempDir()
	t.Setenv("WORKS_FILES_RUNTIME", root)
	p := filepath.Join(root, "frontend-assets", "assets", "previous-release-chunk.js")
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("export const retained=true"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := worksReadAsset("assets/previous-release-chunk.js")
	if err != nil || string(got) != "export const retained=true" {
		t.Fatalf("%s %v", got, err)
	}
	for _, path := range []string{"assets/../../secrets.json", "../secrets.json", "secrets.json", "/assets/previous-release-chunk.js"} {
		if _, err := worksReadAsset(path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	t.Setenv("WORKS_FILES_RUNTIME", "")
	if _, err := worksReadAsset("assets/previous-release-chunk.js"); err == nil {
		t.Fatal("vanilla unexpectedly reads Works cache")
	}
}
