# Training Bot RAG Hub

Training Bot RAG Hub は、Personal Multi Trading Platform 内で Training Bot / AI分析画面 / Bot検証画面が参照するRAG基盤です。

## 最重要原則

- RAGは注文しない
- RAGはBot設定を変更しない
- RAGは緊急停止を解除しない
- RAGは判断材料だけを返す
- RAG出力は必ず検証する
- RAG利用履歴は必ず保存する
- ProviderはAdapter経由で呼び出す
- Secretをログ・回答・Provider送信に含めない

## 構成

```text
apps/
  api/       NestJS API
  web/       Future UI placeholder

packages/
  shared/    Shared types and constants
```

## 初期セットアップ
```
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

## 開発起動
```
pnpm dev
```
Health check:
```
curl http://localhost:3000/health
```

## GitHub Issue運用
- Issue単位でbranchを切る
- PRはIssueに紐づける
- typecheck / lint / test / build を通してからレビューに出す

Branch例:
```
feature/gh-001-repository-setup
```