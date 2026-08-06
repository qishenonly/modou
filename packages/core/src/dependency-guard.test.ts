import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

// 分层铁律：core 是零 UI 依赖的内核，不得依赖任何 UI / 前端符号，
// 也不得依赖 core 之外的项目内包（@modou/* 且 ≠ @modou/core）。
const FORBIDDEN = new Set(['tui', 'ink', 'react', '@modou/tui']);

interface ImportHit {
  specifier: string;
  line: number;
}

/** 规范化模块说明符：去引号，取第一段路径；scoped 包（@scope/pkg）保留完整作用域名。 */
function normalizeSpecifier(raw: string): string {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
  const segments = cleaned.split('/');
  if (cleaned.startsWith('@')) {
    return segments.slice(0, 2).join('/');
  }
  return segments[0] ?? cleaned;
}

/** 是否命中禁止集：tui / ink / react / @modou/tui，以及 core 之外的其他 @modou/* 包。 */
function isForbidden(normalized: string): boolean {
  if (FORBIDDEN.has(normalized)) return true;
  if (normalized.startsWith('@modou/') && normalized !== '@modou/core')
    return true;
  return false;
}

/** 递归收集目录下所有 .ts 文件（排除 dist / node_modules）。 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entryName of readdirSync(dir)) {
    if (entryName === 'dist' || entryName === 'node_modules') continue;
    const fullPath = join(dir, entryName);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (stat.isFile() && entryName.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * 从源码中提取 import / require 模块说明符及其所在行，覆盖：
 * - import ... from "X" 与 import "X"（副作用导入）
 * - export ... from "X" / export * from "X"（再导出同样是依赖）
 * - 动态 import("X")
 * - require("X") 与 import x = require("X")
 */
function extractImportHits(filePath: string): ImportHit[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: ImportHit[] = [];

  const record = (moduleSpecifier: ts.Expression): void => {
    if (!ts.isStringLiteral(moduleSpecifier)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      moduleSpecifier.getStart(sourceFile),
    );
    hits.push({ specifier: moduleSpecifier.text, line: line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier) record(specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) record(reference.expression);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(expression) && expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument) record(argument);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hits;
}

/** 扫描 core 源码，返回所有依赖方向违规（含文件、说明符、行号）。 */
function collectViolations(coreSrcDir: string): string[] {
  const violations: string[] = [];
  for (const filePath of collectTsFiles(coreSrcDir)) {
    for (const hit of extractImportHits(filePath)) {
      const normalized = normalizeSpecifier(hit.specifier);
      if (isForbidden(normalized)) {
        const relPath = relative(coreSrcDir, filePath);
        violations.push(
          `${relPath}:${hit.line}\timport "${hit.specifier}" → 命中禁止集 "${normalized}"`,
        );
      }
    }
  }
  return violations;
}

describe('依赖方向守卫（T-003）', () => {
  test('core 源码不得 import 任何 UI / 前端符号或其他 @modou/* 包', () => {
    const coreSrcDir = import.meta.dir;
    const violations = collectViolations(coreSrcDir);
    if (violations.length > 0) {
      throw new Error(
        `检测到 ${violations.length} 处依赖方向违规：\n${violations.join('\n')}`,
      );
    }
  });

  test('core 的 package.json dependencies 不含禁止包', () => {
    const coreSrcDir = import.meta.dir;
    const packagePath = join(coreSrcDir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = pkg.dependencies ?? {};
    const forbiddenDeps = Object.keys(dependencies)
      .map((name) => ({ name, normalized: normalizeSpecifier(name) }))
      .filter((entry) => isForbidden(entry.normalized))
      .map((entry) => `${entry.name}（normalized ${entry.normalized}）`);
    expect(forbiddenDeps).toEqual([]);
  });
});
