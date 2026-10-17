// scanRedirects / assistantShellHardNo 单测（原生 redirect deny 已撤，这里是唯一闸门）。
// 跑法：node --test plugin/assistant.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { assistantShellHardNo } from "./assistant.ts"

const allow = (c) => assert.equal(assistantShellHardNo(c), null, "应放行：" + c)
const deny = (c) => assert.notEqual(assistantShellHardNo(c), null, "应拦截：" + c)

test("放行：合法只读写法与无害重定向", () => {
  for (const c of [
    'rg -o -m 3 "a>={1}" /etc/hostname',
    "rg -n 'a > b' /etc/hostname",
    "git status 2>/dev/null",
    "ls /tmp 2>/dev/null | wc -l",
    "ls /tmp 2>&1 | wc -l",
    "ls >/dev/null 2>/dev/null",
    "ls $(pwd)",
    "dbq --pretty 'SELECT 1'",
    "rg --prefix x /etc/hostname",
    "ls $((1>2))",
    "ls $((1 > 2))",
    'ls "$((1>2))"',
    'ls "$(rg \'a > b\' /etc/hostname)"',
    "grep -c localhost /etc/hosts",
    "cat /etc/hostname",
    "head -n 5 /etc/hostname",
    "ls; wc -l /etc/hosts",
    "node --version",
    "node --version 2>/dev/null",
    "/usr/bin/node --version",
    "node --version | head -1",
    "rg '--version' f",
    "git --version && date",
    "tail -n 3 /etc/hostname",
    "tail -n 50 /var/log/syslog",
  ]) allow(c)
})

test("拦截：写文件的重定向", () => {
  for (const c of [
    "ls /tmp > /tmp/opencode/x.txt",
    "ls /tmp>/tmp/opencode/x.txt",
    "ls >/tmp/opencode/x.txt 2>/dev/null",
    "ls >>/tmp/opencode/x.txt",
    "ls >|/tmp/opencode/x.txt",
    "ls <>/tmp/opencode/x.txt",
    'ls > "a b.txt"',
    'ls "$(ls>/tmp/opencode/x.txt)"',
    'ls "`ls>/tmp/opencode/x.txt`"',
    'ls "${x:-$(ls>/tmp/opencode/x.txt)}"',
    "ls $(ls > /tmp/opencode/x.txt)",
  ]) deny(c)
})

test("拦截：旗标 / 解释器 / 白名单外", () => {
  for (const c of [
    "rg --pre 'x' /etc/hostname",
    "rg --pre=x /etc/hostname",
    "python3 -c 'print(1)'",
    "sh -c 'ls'",
    "find / -name x",
    "xargs ls",
    "less /etc/hostname",
    "sed -n 1p /etc/hostname",
    "xxd -r /tmp/a /tmp/b",
    "git log --oneline --output=/tmp/x",
    "ss -K dst 1.2.3.4",
    "tail -f /var/log/syslog",
    "tail -F /var/log/syslog",
    "tail --follow /var/log/syslog",
    "tail -n +1 -f /var/log/syslog",
    "tail -qf /var/log/syslog",
    "rm -rf /tmp/x",
    "sh -c 'rm x' --version",
    "node --version --foo",
    "node --version > /tmp/opencode/x",
    "date; node --version --foo",
    "$(rm>/tmp/x) --version",
  ]) deny(c)
})

test("分段与命令前缀", () => {
  deny("ls; rm -rf /tmp/x")
  deny("command rm x")
  allow("command ls /tmp")
  allow("rtk ls /tmp")
  deny("ls && cat /etc/hostname > /tmp/opencode/x")
})
