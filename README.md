# Gemini TTS on Cloudflare Workers

Google AI Studio の `google-genai` Python サンプル（`gemini-2.5-pro-preview-tts` で
テキストを読み上げて WAV に保存するスクリプト）を、Cloudflare Workers 上の
Web アプリとして移植したものです。

- **フロントエンド** (`public/index.html`): テキスト・ボイス・モデルを指定して生成、
  ブラウザで再生 / WAV ダウンロード。Workers Static Assets で配信。
- **Worker** (`src/index.ts`): Gemini のストリーミング REST API
  (`streamGenerateContent?alt=sse`, `responseModalities: ["AUDIO"]`) を呼び出し、
  届いた PCM (`audio/L16;rate=24000`) チャンクを WAV ヘッダ付きでそのままブラウザへ
  ストリーミングします。API キーはブラウザに露出しません。

## API

| Method | Path          | 説明 |
| ------ | ------------- | ---- |
| `POST` | `/api/tts`    | `{ "text": "...", "voice": "Zephyr", "model": "gemini-2.5-pro-preview-tts", "temperature": 1 }` を受け取り `audio/wav` をストリーミングで返す |
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
- 長文では生成に数分かかることがあります。Cloudflare は約 100 秒間 1 バイトも
  返さないオリジンを HTTP 524 で切断するため、Gemini 呼び出しとクライアントへの
  応答の両方をストリーミングにしています（最初の音声チャンクは数秒で届きます）。
- ストリーミング中は WAV の長さが確定しないため、Worker が書くヘッダの RIFF / data
  サイズは `0xFFFFFFFF`（長さ不明）です。ブラウザ側 (`public/index.html`) が受信完了後に
  正しい値へ書き換えます。curl で保存したファイルはヘッダがそのままなので、必要なら
  `ffmpeg -i in.wav -c copy out.wav` で正規化してください。
- Cloudflare Access で保護している場合、curl からはサービストークン
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ) が必要です。
- 対応モデル: `gemini-2.5-pro-preview-tts`, `gemini-2.5-flash-preview-tts`。
