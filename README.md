# Gemini TTS on Cloudflare Workers

Google AI Studio の `google-genai` Python サンプル（`gemini-2.5-pro-preview-tts` で
テキストを読み上げて WAV に保存するスクリプト）を、Cloudflare Workers 上の
Web アプリとして移植したものです。

- **フロントエンド** (`public/index.html`): テキスト・ボイス・モデルを指定して生成、
  ブラウザで再生 / WAV ダウンロード。Workers Static Assets で配信。
- **Worker** (`src/index.ts`): Gemini REST API (`generateContent`,
  `responseModalities: ["AUDIO"]`) を呼び出し、返ってきた PCM (`audio/L16;rate=24000`)
  に WAV ヘッダを付けて返します。API キーはブラウザに露出しません。

## API

| Method | Path          | 説明 |
| ------ | ------------- | ---- |
| `POST` | `/api/tts`    | `{ "text": "...", "voice": "Zephyr", "model": "gemini-2.5-pro-preview-tts", "temperature": 1 }` を受け取り `audio/wav` を返す |
| `GET`  | `/api/voices` | 利用可能なボイス・モデル一覧 |

```sh
curl -X POST https://<your-worker>.workers.dev/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"こんにちは、世界。","voice":"Zephyr"}' \
  -o hello.wav
```

## セットアップ

```sh
npm install
```

### ローカル開発

```sh
cp .dev.vars.example .dev.vars   # GEMINI_API_KEY を記入
npm run dev                      # http://localhost:8787
```

### デプロイ

```sh
npx wrangler login
npx wrangler secret put GEMINI_API_KEY   # Gemini API キーを入力
npm run deploy
```

### 検証

```sh
npm run check   # tsc --noEmit && wrangler deploy --dry-run
```

## 補足

- 入力は最大 20,000 文字に制限しています（`src/index.ts` の `MAX_TEXT_LENGTH`）。
- 長文では生成に 1 分前後かかることがあります。Workers は外部 fetch の待ち時間に
  CPU 時間制限を消費しないため、そのまま待機できます。
- 対応モデル: `gemini-2.5-pro-preview-tts`, `gemini-2.5-flash-preview-tts`。
