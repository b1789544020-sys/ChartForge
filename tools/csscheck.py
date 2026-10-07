"""CSS 结构静态检查：检测未闭合规则块 / 游离声明。

浏览器对未闭合的 `{` 会做错误恢复，把后续所有规则都吞进同一个块里，
表现为"整片样式莫名失效"，且花括号数量仍然平衡，很难肉眼发现。
本脚本在解析层面把这种问题揪出来。

用法: python tools/csscheck.py [css/style.css]
"""
import os
import re
import sys

AT_NEST = ('@media', '@supports', '@keyframes', '@-webkit-keyframes', '@layer', '@container')


def check(path):
    with open(path, encoding='utf-8') as f:
        src = f.read()

    # 去掉注释，但保留换行以便定位行号
    stripped = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), src, flags=re.S)

    problems = []
    stack = []          # [(行号, 选择器)]
    seg_start = 0       # 当前段起点
    last_delim = '}'    # 上一个分隔符：'{' 表示段内是声明，'}' 表示段内应是选择器
    line = 1

    for i, ch in enumerate(stripped):
        if ch == '\n':
            line += 1
            continue
        if ch == '{':
            selector = stripped[seg_start:i].strip()
            # 嵌套只允许出现在 @media / @keyframes 等条件组规则内部
            if stack:
                outer = stack[-1][1].lower()
                if not outer.startswith(AT_NEST):
                    problems.append(
                        '第 %d 行: 规则 "%s" 嵌套在非条件组规则 "%s"(第 %d 行)内 '
                        '=> 上层大概率缺少 "}"' % (line, selector[:60], stack[-1][1][:60], stack[-1][0]))
            stack.append((line, selector))
            seg_start = i + 1
            last_delim = '{'
        elif ch == '}':
            tail = stripped[seg_start:i].strip()
            # 上一个分隔符是 '}' 说明这段文本不属于任何 '{'，却以 '}' 收尾 => 游离声明
            if last_delim == '}' and tail and ':' in tail and not tail.startswith('@'):
                problems.append('第 %d 行: 游离声明 "%s"' % (line, ' '.join(tail.split())[:60]))
            if not stack:
                problems.append('第 %d 行: 多余的 "}"' % line)
            else:
                stack.pop()
            seg_start = i + 1
            last_delim = '}'

    for ln, sel in stack:
        problems.append('第 %d 行: 规则 "%s" 未闭合（后续样式会被浏览器一并吞掉）' % (ln, ' '.join(sel.split())[:60]))

    rest = stripped[seg_start:].strip()
    if rest and ':' in rest:
        problems.append('文件末尾存在游离声明 "%s"' % ' '.join(rest.split())[:60])

    return problems


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    targets = sys.argv[1:] or [os.path.join(root, 'css', 'style.css')]
    failed = 0
    for t in targets:
        problems = check(t)
        name = os.path.relpath(t, root)
        if problems:
            failed += 1
            print('[FAIL] %s' % name)
            for p in problems:
                print('   - %s' % p)
        else:
            print('[OK] %s 结构正常' % name)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
