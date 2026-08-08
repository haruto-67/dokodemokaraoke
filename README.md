# どこでもカラオケセット (Dokokara Karaoke Set)

手持ちの楽曲(オンボーカル音源＋オフボーカル音源)からメロディを自動解析し、歌詞とタイミングを結びつけて自分専用のカラオケコンテンツを作成・再生するmacOSデスクトップアプリ。詳細は `カラオケアプリ 要件定義 v2.md` を参照。

## 動作環境

- macOS(Apple Silicon / arm64 のみ)。Intel Mac・Windows・Linux は非対応。

## 開発

```bash
npm install
npm run dev        # 開発モードで起動
npm run typecheck  # 型チェック
npm run test       # 単体テスト(vitest)
npm run build:mac  # DMGビルド(release/ 以下に出力)
```

## 初回起動手順(配布を受け取った方向け)

本アプリは Apple Developer Program に加入せず、ad-hoc 署名のみで配布しています(公証は行っていません)。そのため初回起動時に macOS の Gatekeeper に「開発元が未確認」として拒否される場合があります。以下のいずれかの方法で開いてください。

**方法1: ターミナルで隔離属性を外す**

```bash
xattr -dr com.apple.quarantine "/Applications/どこでもカラオケセット.app"
```

(アプリを Applications フォルダ以外に置いた場合はパスを読み替えてください)

**方法2: システム設定から許可する**

1. DMGを開き、アプリを Applications フォルダなどへドラッグしてコピーする
2. アプリを起動しようとすると警告が表示されるので、いったん閉じる
3. システム設定 →「プライバシーとセキュリティ」を開く
4. 「このまま開く」ボタンが表示されていれば選択する

## ビルドについて

- `npm run build:mac` で `release/` 以下に arm64 DMG を生成します
- `build/afterPack.cjs` が electron-builder の afterPack フックとして動作し、ad-hoc 署名(`codesign --sign -`)と
  Apple Silicon で V8 の JIT を動作させるための entitlements(`build/entitlements.mac.plist`)を適用した上で、
  署名が正しく行われたことを検証します。署名やentitlementsの付与に失敗した場合はビルド自体が失敗します
