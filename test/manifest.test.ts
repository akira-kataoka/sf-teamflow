import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// 公開（マーケットプレイス）に必要な package.json の不変条件を固定するテスト。
// 将来の編集で公開要件（アイコン寸法・publisher・engines整合・信頼宣言など）を
// うっかり壊さないための回帰テスト。`node --test` はリポジトリ直下から実行されるため
// process.cwd() がリポジトリルート。
const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/** PNG ヘッダから幅・高さ（ピクセル）を読む。署名検証込み。 */
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  // PNG シグネチャ: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    assert.equal(b[i], sig[i], `PNG シグネチャ不正 (byte ${i})`);
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** "^1.85.0" / "1.85.0" → { major, minor }。 */
function majorMinor(range: string): { major: number; minor: number } {
  const m = /(\d+)\.(\d+)\.\d+/.exec(range);
  assert.ok(m, `バージョン表記を解釈できない: ${range}`);
  return { major: Number(m![1]), minor: Number(m![2]) };
}

test("manifest: publisher が実在し、プレースホルダでない", () => {
  assert.equal(typeof pkg.publisher, "string");
  assert.ok(pkg.publisher.length > 0, "publisher は必須（公開には不可欠）");
  assert.ok(
    !/^(your-publisher|publisher|example|undefined)$/i.test(pkg.publisher),
    "publisher がプレースホルダのまま"
  );
});

test("manifest: version が semver である", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "version は x.y.z 形式");
});

test("manifest: license / repository / main が宣言されている", () => {
  assert.ok(pkg.license, "license は必須");
  assert.ok(pkg.repository?.url, "repository.url は必須（公開ページのリンク）");
  assert.ok(pkg.main, "main（エントリ）は必須");
});

test("manifest: icon が存在する 128x128 以上の PNG", () => {
  assert.equal(pkg.icon, "resources/icon.png");
  const iconPath = resolve(root, pkg.icon);
  assert.ok(existsSync(iconPath), "icon ファイルが存在しない");
  const { width, height } = pngSize(iconPath);
  // マーケットプレイスは 128x128 以上の正方形 PNG を要求する。
  assert.ok(width >= 128 && height >= 128, `icon は 128x128 以上が必要: ${width}x${height}`);
  assert.equal(width, height, `icon は正方形であるべき: ${width}x${height}`);
});

test("manifest: engines.vscode と @types/vscode の major.minor が一致する", () => {
  const eng = majorMinor(pkg.engines.vscode);
  const types = majorMinor(pkg.devDependencies["@types/vscode"]);
  assert.deepEqual(
    eng,
    types,
    "engines.vscode と @types/vscode がずれると、存在しない API を使ってもビルドが通ってしまう"
  );
});

test("manifest: 制限ワークスペースは非対応を宣言し、理由を添える", () => {
  // git / sf を実行するため、信頼されたワークスペースが前提（README の案内と整合）。
  assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, false);
  assert.ok(
    (pkg.capabilities.untrustedWorkspaces.description ?? "").length > 0,
    "非対応の理由（description）をユーザーに示すべき"
  );
});

test("manifest: activationEvents に onStartupFinished を含む", () => {
  assert.ok(Array.isArray(pkg.activationEvents));
  assert.ok(
    pkg.activationEvents.includes("onStartupFinished"),
    "ホーム/ステータスバーの初期化のため onStartupFinished が必要"
  );
});
