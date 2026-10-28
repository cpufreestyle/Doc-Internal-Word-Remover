# 从 CHANGELOG.md 截取指定版本小节（不含版本标题行），供 Release notes 使用。
# 用法：awk -v ver=2.88 -f tools/changelog-section.awk CHANGELOG.md
# ver 传不带 v 的主次版本号（CHANGELOG 的小节标题形如 ## v2.88 - 2026-10-07）。
# 匹配该小节起点后原样输出小节内容（含列表项与空行），到下一个 ## 标题行或文件尾结束。
index($0, "## v" ver) == 1 { f = 1; next }
/^## / { f = 0 }
f { print }
