# Gemini TTS on Cloudflare Workers

Google AI Studio の `google-genai` Python サンプル（`gemini-2.5-pro-preview-tts` で
テキストを読み上げて WAV に保存するスクリプト）を、Cloudflare Workers 上の
Web アプリとして移植したものです。

- **フロントエンド** (`public/index.html`): テキスト・ボイス・モデルを指定して生成、
  ブラウザで再生 / WAV ダウンロード。Workers Static Assets で配信。
- **Worker** (`src/index.ts`): テキストを文の区切りで数百文字ずつに分割し、各チャンクを
  Gemini のストリーミング REST API (`streamGenerateContent?alt=sse`,
  `responseModalities: ["AUDIO"]`) に並列で投げます。届いた PCM (`audio/L16;rate=24000`)
  を入力順に WAV ヘッダ付きでブラウザへストリーミングします。API キーはブラウザに露出しません。

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
- Cloudflare は約 100 秒間 1 バイトも返さないオリジンを HTTP 524 で切断します。Gemini の
  TTS モデルは SSE でも音声全体ができるまで何も返さないため、長文を 1 回で投げると
  必ずこれに当たります。そのため Worker はテキストを `TTS_CHUNK_CHARS`（既定 300 文字）
  ごとに分割し、`TTS_CONCURRENCY`（既定 3）本まで並列に呼び出して、順序を保ったまま
  結合します。どちらも `wrangler.jsonc` の `vars` か Secret で上書きできます。
  429 / 5xx は 2 回までリトライします。
- 音声は 24 kHz / 16 bit PCM なので、文章 1 分あたり約 3 MB になります（元記事は約 25 MB）。
  Worker の CPU 時間とメモリ（128 MB）に収めるため、SSE の行分割はバイト単位で 1 回だけ
  デコードし、base64 は `nodejs_compat` の `Buffer` でネイティブに復号し、送信済みチャンクは
  即座に解放しています。上限超過時は Cloudflare が JSON でない 503（Error 1102）を返します。
- チャンク境界では話速や間が少し変わることがあります。気になる場合は
  `TTS_CHUNK_CHARS` を大きくしてください（100 秒以内に 1 チャンクが生成できる範囲で）。
- ストリーミング中は WAV の長さが確定しないため、Worker が書くヘッダの RIFF / data
  サイズは `0xFFFFFFFF`（長さ不明）です。ブラウザ側 (`public/index.html`) が受信完了後に
  正しい値へ書き換えます。curl で保存したファイルはヘッダがそのままなので、必要なら
  `ffmpeg -i in.wav -c copy out.wav` で正規化してください。
- Cloudflare Access で保護している場合、curl からはサービストークン
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ) が必要です。
- 対応モデル: `gemini-2.5-pro-preview-tts`, `gemini-2.5-flash-preview-tts`, `gemini-3.1-flash-tts-preview`。
  無料枠の日次上限はモデルごとに別なので、上限に当たったら別モデルに切り替えられます。
