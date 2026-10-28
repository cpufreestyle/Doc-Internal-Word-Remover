//go:build !windows

package main

import "os/exec"

// hideWindow 非 Windows 平台无此概念，空实现保证可编译
func hideWindow(cmd *exec.Cmd) {}
