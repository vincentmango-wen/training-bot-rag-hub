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
## 初期セットアップ

```bash
npm ci
npm ci --prefix packages/shared
npm ci --prefix apps/api

npm run typecheck
npm run lint
npm run test
npm run build
```
## Local Infrastructure

GH-003では PostgreSQL / Redis / pgvector を Docker Compose で起動します。

### 前提

Docker daemon が起動していることを確認します。

Colimaを使う場合:

```bash
colima start
docker info
```

## 起動
```
npm run docker:up
npm run docker:ps
```

## 期待結果:
```
pmtp-rag-postgres   healthy
pmtp-rag-redis      healthy
```

## PostgreSQL接続確認
```
npm run db:psql
```
psql内で以下を実行します。
```
SELECT current_database();
SELECT current_user;
SELECT extname FROM pg_extension WHERE extname = 'vector';
\q
```
期待結果:
```
current_database = rag_hub
current_user = rag_user
extname = vector
```
Redis接続確認
```
npm run redis:cli
```
redis-cli内で以下を実行します。
```
PING
```
期待結果:
```
PONG
```
ログ確認
```
npm run docker:logs
```
停止
```
npm run docker:down
```
## 初期化SQLを再実行したい場合
PostgreSQLのDocker volumeを削除して再作成します。
```
npm run docker:reset
```
注意: docker:reset はローカルDBデータを削除します。必要な検証データがある場合は実行前に退避してください。


## 開発起動
```
npm run dev
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