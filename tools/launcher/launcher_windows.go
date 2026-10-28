//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow 让 rundll32 不弹黑色命令行窗口（仅 Windows 有效）
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
