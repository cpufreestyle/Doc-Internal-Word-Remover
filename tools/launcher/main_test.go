package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHasIndex(t *testing.T) {
	dir := t.TempDir()
	if hasIndex(dir) {
		t.Fatal("empty dir should not have index.html")
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !hasIndex(dir) {
		t.Fatal("dir with index.html should be detected")
	}
}

func TestListenOnSkipsBusyPort(t *testing.T) {
	// 占住 defaultPort，验证启动器会顺延到下一个端口
	busy, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itoa(defaultPort)))
	if err != nil {
		t.Skipf("port %d unavailable in test env: %v", defaultPort, err)
	}
	defer busy.Close()

	ln, port, err := listenOn("127.0.0.1", defaultPort)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port == defaultPort {
		t.Fatalf("expected a port other than busy %d, got %d", defaultPort, port)
	}
}

func TestListenOnPrefersDefaultWhenFree(t *testing.T) {
	probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itoa(defaultPort)))
	if err != nil {
		t.Skipf("default port %d busy, skip", defaultPort)
	}
	probe.Close() // 确认 8080 可监听

	ln, port, err := listenOn("127.0.0.1", defaultPort)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port != defaultPort {
		t.Fatalf("expected default port %d when free, got %d", defaultPort, port)
	}
}

func TestListenOnHonorsStartPort(t *testing.T) {
	// 命令行传入端口时必须优先使用该端口（此前版本会忽略参数、恒从 8080 起）
	const want = 19090
	probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itoa(want)))
	if err != nil {
		t.Skipf("port %d unavailable in test env: %v", want, err)
	}
	probe.Close() // 确认可监听后释放

	ln, port, err := listenOn("127.0.0.1", want)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port != want {
		t.Fatalf("expected requested port %d, got %d", want, port)
	}
}

func TestListenOnEscalatesFromStartPort(t *testing.T) {
	// 指定端口被占用时从指定端口顺延，而不是回落到 defaultPort
	const want = 19190
	busy, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", itoa(want)))
	if err != nil {
		t.Skipf("port %d unavailable in test env: %v", want, err)
	}
	defer busy.Close()

	ln, port, err := listenOn("127.0.0.1", want)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port == want || port == defaultPort {
		t.Fatalf("expected escalation from %d, got %d", want, port)
	}
}

func TestNoCacheHeaders(t *testing.T) {
	h := noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "no-store, must-revalidate" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}


func TestFindIndexNearSelf(t *testing.T) {
	// EXE 同目录就有 index.html：直接返回该目录，不往子目录找
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 同时在子目录放一个：同目录命中时不该被子目录抢走
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := findIndexNear(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != dir {
		t.Fatalf("expected %q, got %q", dir, got)
	}
}

func TestFindIndexNearSubdir(t *testing.T) {
	// 同目录没有，下一级子目录有：应定位到那个子目录
	dir := t.TempDir()
	sub := filepath.Join(dir, "payload")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := findIndexNear(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != sub {
		t.Fatalf("expected %q, got %q", sub, got)
	}
}

func TestFindIndexNearTwoLevels(t *testing.T) {
	// 两层子目录（dist/app/index.html）也该找到
	dir := t.TempDir()
	deep := filepath.Join(dir, "dist", "app")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := findIndexNear(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != deep {
		t.Fatalf("expected %q, got %q", deep, got)
	}
}

func TestFindIndexNearSkipsThirdLevel(t *testing.T) {
	// 只在第三层有 index.html：超出「下两级」的范围，必须找不到
	dir := t.TempDir()
	deep := filepath.Join(dir, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := findIndexNear(dir); err == nil {
		t.Fatalf("expected error for 3-level-deep index.html, got %q", got)
	}
}

func TestFindIndexNearNone(t *testing.T) {
	// 空目录树：报错且错误信息带上起始目录
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "css"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := findIndexNear(dir)
	if err == nil {
		t.Fatalf("expected error, got %q", got)
	}
	if got != "" {
		t.Fatalf("expected empty path on error, got %q", got)
	}
	if !strings.Contains(err.Error(), "index.html not found") {
		t.Fatalf("error should mention index.html, got %v", err)
	}
}

func TestFindIndexNearIgnoresDirNamedIndex(t *testing.T) {
	// index.html 是同名目录而不是文件：不算命中
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "index.html"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := findIndexNear(dir); err == nil {
		t.Fatal("a directory named index.html must not count as a hit")
	}
}

func TestNoCacheSetsBothHeaders(t *testing.T) {
	// noCache 同时设 Cache-Control 与 X-Content-Type-Options（后者此前无断言）
	h := noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "no-store, must-revalidate" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestNoCachePassesThroughBody(t *testing.T) {
	// noCache 不能吞掉响应体（包了 Handler，内容要原样透传）
	const body = "hello-dwr"
	h := noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Body.String() != body {
		t.Fatalf("body = %q, want %q", rec.Body.String(), body)
	}
}


func TestBannerFormatAndVersion(t *testing.T) {
	// banner() 的版本号来自构建期 -ldflags "-X main.buildVersion=..."，
	// 此前零覆盖：写错变量名或格式串时编译照样过，发布出去用户看到空版本号。
	old := buildVersion
	defer func() { buildVersion = old }()

	// 1) 版本号必须原样出现在第二行
	buildVersion = "v9.9.9-test"
	var buf bytes.Buffer
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	banner(buildVersion)
	_ = w.Close()
	os.Stdout = oldStdout
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.Contains(out, "v9.9.9-test") {
		t.Fatalf("banner should print the version, got %q", out)
	}
	if !strings.Contains(out, "Doc-Internal-Word-Remover Launcher") {
		t.Fatalf("banner should name the launcher, got %q", out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("banner should be 3 lines, got %d: %q", len(lines), out)
	}
	if !strings.HasPrefix(lines[0], "====") || !strings.HasPrefix(lines[2], "====") {
		t.Fatalf("banner rule lines should be ==== prefixed, got %q / %q", lines[0], lines[2])
	}
}

func TestBannerEmptyVersionDoesNotPanic(t *testing.T) {
	// 本地 go run 未传 -ldflags 时 buildVersion 为空：banner 不能崩，也不能把
	// "Launcher " 后面拼出怪异内容（空串时是 "Launcher "，尾随空格可接受，但不许 panic）
	old := buildVersion
	defer func() { buildVersion = old }()
	buildVersion = ""
	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("banner panicked on empty version: %v", rec)
		}
	}()
	banner(buildVersion)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
