// 启动工具（launcher）：文档敏感词清除工具的本地服务器启动器
//
// 设计目标：一个 32 位静态 EXE，Windows 7（x86 / x64）到 Windows 11 均可直接运行，
// 不依赖 Go / Node / .NET 等任何运行时，也不需要系统安装任何组件。
// 行为：在本机回环端口静态托管工具目录（index.html + css + js + scan.mjs 等），
// 然后打开默认浏览器访问工具页面；关闭本窗口（或 Ctrl+C）即停止服务。
package main

import (
	"context"
	"errors"
	"fmt"


	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultPort = 8080
	maxPortTry  = 50
)

// findIndexNear 在 dir 自身及其下两级子目录里找含 index.html 的目录，
// 返回第一个命中的目录（filepath.Walk 的词序，保证结果可复现）。
// 抽成独立函数是为了可测：resolveRoot 依赖 os.Executable()，测试里无法控制。
func findIndexNear(dir string) (string, error) {
	if hasIndex(dir) {
		return dir, nil
	}
	var found string
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || found != "" || info == nil || !info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		if rel != "" && strings.Count(rel, string(os.PathSeparator)) >= 2 {
			return filepath.SkipDir
		}
		if hasIndex(p) {
			found = p
		}
		return nil
	})
	if found != "" {
		return found, nil
	}
	return "", errors.New("index.html not found near " + dir)
}

// resolveRoot 定位工具目录：优先 EXE 所在目录，其次其下两级内含 index.html 的子目录
func resolveRoot() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	if abs, err2 := filepath.Abs(dir); err2 == nil {
		dir = abs
	}
	return findIndexNear(dir)
}

func hasIndex(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !st.IsDir()
}

// listenOn 从 start 起依次尝试一段端口（start<=0 时从 defaultPort 起），
// 全部占用则让系统分配空闲端口。命令行传入的端口优先：start 即用户指定值
func listenOn(host string, start int) (net.Listener, int, error) {
	if start <= 0 {
		start = defaultPort
	}
	for p := start; p < start+maxPortTry; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err == nil {
			return ln, p, nil
		}
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return nil, 0, err
	}
	return ln, ln.Addr().(*net.TCPAddr).Port, nil
}

func openBrowser(url string) {
	// rundll32 调用系统默认协议处理器，不会弹出黑色命令行窗口
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	hideWindow(cmd)
	// HideWindow 仅在 windows 构建下生效（见 launcher_windows.go / launcher_other.go）
	_ = cmd.Start()
	_ = cmd.Wait()
}

func banner(version string) {
	fmt.Println("================================================")
	fmt.Println("  Doc-Internal-Word-Remover Launcher " + version)
	fmt.Println("================================================")
}

func main() {
	args := os.Args[1:]
	wantPort := 0
	for _, a := range args {
		if n, err := strconv.Atoi(a); err == nil && n > 0 && n < 65536 {
			wantPort = n
		}
	}

	root, err := resolveRoot()
	if err != nil {
		fmt.Println("[ERROR] cannot locate app directory (index.html missing): " + err.Error())
		fmt.Println("        Please keep this exe together with index.html / css / js / scan.mjs.")
		fmt.Print("Press Enter to exit...")
		var tmp [1]byte
		_, _ = os.Stdin.Read(tmp[:])
		os.Exit(1)
	}

	// 命令行传入的端口优先（如「启动工具.exe 9090」），未传时从 defaultPort 起顺延
	startPort := defaultPort
	if wantPort > 0 {
		startPort = wantPort
	}
	ln, port, err := listenOn("127.0.0.1", startPort)
	if err != nil {
		fmt.Println("[ERROR] cannot listen on 127.0.0.1: " + err.Error())
		fmt.Print("Press Enter to exit...")
		var tmp [1]byte
		_, _ = os.Stdin.Read(tmp[:])
		os.Exit(1)
	}
	if wantPort > 0 && wantPort != port {
		fmt.Printf("[warn] port %d busy, using %d instead\n", wantPort, port)
	}

	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.Dir(root))))
	srv := &http.Server{Handler: mux}

	go func() { _ = srv.Serve(ln) }()

	url := fmt.Sprintf("http://127.0.0.1:%d/index.html", port)
	banner(buildVersion)
	fmt.Println("[OK] App directory: " + root)
	fmt.Println("[OK] Local URL    : " + url)
	fmt.Println("[--] Browser is opening... (if not, open the URL above manually)")
	fmt.Println("[OK] Press Ctrl+C (or close this window) to stop the service.")
	fmt.Println("------------------------------------------------")

	openBrowser(url)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	fmt.Println()
	fmt.Println("Stopping...")
	done := make(chan struct{})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	fmt.Println("Service stopped. Goodbye.")
}

// noCache 本地开发/使用场景避免浏览器缓存旧版页面
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// 供构建脚本写入版本号（-ldflags "-X main.buildVersion=..."）
var buildVersion = ""
