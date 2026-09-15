/** 从实际命令注册同步并校验 README 命令树，不执行任何业务命令。@author xiuyu.yi */
import { readFile, writeFile } from 'node:fs/promises';
import { createProgram } from '../dist/program.js';

const write = process.argv.includes('--write');
const program = createProgram(
  { output: {}, signal: new AbortController().signal },
  {
    beforeBusiness: async () => {
      throw new Error('文档脚本禁止执行业务');
    },
    update: async () => {
      throw new Error('文档脚本禁止更新 CLI');
    },
  },
);
const treePattern = /```text\nsuperun-ai\n[\s\S]*?\n```/;
let failed = false;
for (const filename of ['README.md', 'README.en.md']) {
  const file = new URL(`../${filename}`, import.meta.url);
  const source = await readFile(file, 'utf8');
  const previous = source.match(treePattern)?.[0];
  if (!previous) throw new Error(`${filename} 缺少命令树`);
  const stack = [],
    descriptions = new Map(),
    documented = [];
  for (const line of previous.split('\n')) {
    const match = line.match(/^([│ ]*)(?:├──|└──) (.*?)\s+# (.*)$/);
    if (!match) continue;
    const depth = match[1].length / 4;
    const [name] = match[2].split(/\s+/);
    stack.length = depth;
    const path = [...stack, name].join(' ');
    descriptions.set(path, match[3]);
    documented.push(`${stack.join(' ')} ${match[2].trim()}`.trim());
    stack.push(name);
  }
  const expected = [],
    lines = ['```text', program.name()];
  function visit(parent, prefix = '', path = []) {
    parent.commands.forEach((command, index) => {
      const last = index === parent.commands.length - 1;
      const args = command.registeredArguments.map(
        (arg) =>
          `${arg.required ? '<' : '['}${arg.name()}${arg.variadic ? '...' : ''}${arg.required ? '>' : ']'}`,
      );
      const signature = [command.name(), ...args].join(' ');
      const fullPath = [...path, command.name()];
      expected.push([...path, signature].join(' '));
      const description =
        filename === 'README.en.md'
          ? (descriptions.get(fullPath.join(' ')) ?? command.description())
          : command.description();
      lines.push(`${prefix}${last ? '└──' : '├──'} ${signature}`.padEnd(65) + ` # ${description}`);
      visit(command, prefix + (last ? '    ' : '│   '), fullPath);
    });
  }
  visit(program);
  lines.push('```');
  if (write) {
    await writeFile(file, source.replace(treePattern, lines.join('\n')));
    console.log(`${filename} 命令树已同步（${expected.length} 项）`);
  } else if (JSON.stringify(documented) !== JSON.stringify(expected)) {
    failed = true;
    console.error(`${filename} 命令树与实际注册不一致，请执行 npm run docs:sync`);
  } else console.log(`${filename} 命令树校验通过（${expected.length} 项）`);
}
if (failed) process.exitCode = 1;
