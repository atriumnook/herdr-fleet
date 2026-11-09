# workflow `rust` に、Rust と TypeScript の `fleet` で fleet CLI の契約を走らせる job `fleet-cli` を足す

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #251

## 状況

ADR `0242-phase-3-split` は、段階 3 の完了条件「fleet CLI の契約が Rust の CLI と Rust の core で通る」の一部として、Rust の `fleet` が fleet CLI の契約(`fixtures/fleet-cli/` の 87 件)を `HERDR_FLEET_CLI_TARGET=rust:<実行ファイルのパス>` で通すことを、この Issue に割り当てた。Issue の受け入れ条件は、その手順を workflow `rust` に足し、中身と理由を ADR に書くことを求めている。bun の入れ方は ADR `0194-ts-corpus-job` の job `ts-corpus` と同じにする。

決める必要があったのは次のこと。

- 既存の job `linux` に手順を足すか、job を分けるか
- Rust の CLI だけを走らせるか、TypeScript の CLI も走らせるか
- bun の入れ方を共有するか、写すか

前提と制約:

- 契約の runner(`scripts/fleet-cli-fixtures.ts`)は、件ごとに 7400〜7499 の port で stub のサーバーを起動し、CLI に `PATH`、`HOME`、`TMPDIR`、`TZ=UTC`、`LANG=en_US.UTF-8`、件の変数、stub の `HERDR_FLEET_URL` だけを渡す。CLI が稼働中の fleet(port 7317)に送ることはない
- `bin/fleet-cli-fixtures.test.ts` は node_modules がなくても通る(下の「確かめたこと」)。`bunfig.toml` の preload(`scripts/test-herdr.ts`)は、`HERDR_TEST_MODE=unit` のとき herdr を起動しない
- 決まりにより、workflow の権限は `contents: read` のままにし、secrets を使わない。この Issue が書けるのは `.github/workflows/rust.yml` だけで、composite action(`.github/actions/`)は作れない

## 決定

### job `fleet-cli`(`.github/workflows/rust.yml`)

- workflow `rust` の 3 つ目の job にする。きっかけ、`permissions: contents: read`、`concurrency` は、ほかの 2 つの job と共有する
- runner は `ubuntu-24.04`、`timeout-minutes: 30`、手順は `shell: bash`
- 手順は次の順に走らせる
  1. `actions/checkout`(ほかの job と同じ SHA、`persist-credentials: false`)
  2. `rust/` で `rustup toolchain install --no-self-update`(`rust/rust-toolchain.toml` の版)
  3. `rust/` で `cargo build --locked -p herdr-fleet-cli`(debug の build。実行ファイルは `rust/target/debug/fleet`)
  4. bun 1.4.4 を入れる。job `ts-corpus` と同じ手順(release の zip、失敗したら REST API で同じ asset を取り、固定した sha256 で確かめてから開く)を写し、`BUN_VERSION` と `BUN_SHA256` も同じ値にする
  5. `bun --version` が 1.4.4 であることを確かめる
  6. TypeScript の CLI で契約を走らせる: `HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock bun test bin/fleet-cli-fixtures.test.ts`
  7. Rust の CLI で契約を走らせる: 同じコマンドに `HERDR_FLEET_CLI_TARGET=rust:rust/target/debug/fleet` を足す

### 理由

- job を分ける: bun の取得は外部の release に頼り、2026-11-08 に 504 を返したことがある(ADR `0194-ts-corpus-job`)。job `linux` に入れると、bun の取得の失敗で Rust の検査(fmt、clippy、test)の結果まで赤くなり、どちらが失敗したか見分けにくい。分けた分だけ cli の crate とその依存を job `linux` と合わせて 2 回 build するが、cli が依存するのは protocol、serde、serde_json、jiff、ureq(TLS なし)だけで、手元(16 コア)のクリーン build は 8 秒だった
- TypeScript の CLI でも走らせる: 件を Rust の答えに合わせて書き換え、`bin/fleet.ts` を直さない pull request は、Rust の CLI では通ってしまう。TypeScript の CLI でも走らせれば、その pull request は赤くなる。job `ts-corpus` が画面と会話ログの corpus に対して決めたこと(ADR `0194-ts-corpus-job`)を、fleet CLI の契約にも当てる。job `ts-corpus` に足さないのは、TypeScript と Rust の 2 回の実行を 1 つの job に並べ、同じ件の両方の結果を 1 か所で読めるようにするため
- debug の build: 契約が確かめるのは引数・出力・終了コードで、最適化の有無で変わらない。Issue の検査のコマンド(`rust/target/debug/fleet`)とも同じになる
- bun の手順を写す: composite action はこの Issue の書くパスの外にある。写した手順は job `fleet-cli` の 1 か所だけで、版と sha256 を変えるときは 2 つの job を同じ pull request で直す(両方の job の注記に書いた)

## 検討した代わり

- job `linux` の最後に手順を足す: cargo の build を共有できるが、上の理由で bun の取得の失敗が Rust の検査を巻き込む
- job `ts-corpus` に Rust の build と Rust の CLI の実行を足す: job の名前と ADR `0194-ts-corpus-job` の目的(TypeScript の実装の確認)から外れ、Rust の toolchain を入れる手順がその job に加わる
- Rust の CLI だけを走らせる: 件を Rust に合わせて書き換えたときに CI で見えない(上の理由)
- cache(`actions/cache`)で build を速くする: ADR `0110-workspace-and-ci` は使う action を `actions/checkout` だけにしている。cli のクリーン build は手元(16 コア)で 8 秒だった

## 依存

なし。外部の action も crate も足さない。bun は job `ts-corpus` と同じ版と sha256 で入れる。

## 結果

- base が `rust` のすべての pull request と `rust` への push で、Rust の `fleet` と TypeScript の `fleet` の両方が fleet CLI の契約を通すことを CI が確かめる
- `fixtures/fleet-cli/` の件を変える pull request は、`bin/fleet.ts` も同じ振る舞いにしないと赤くなる
- bun の版を上げるときは、job `ts-corpus` と job `fleet-cli` の `BUN_VERSION` と `BUN_SHA256` を同じ pull request で直す
- CC(#274)と LIVE(#270)が Rust の CLI を Rust の core に当てる検査は、この job に含めない。それぞれの Issue が置く

## 確かめたこと

- 手元で、node_modules のない worktree で、bun 1.4.4 で `HERDR_*` を外し `HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock` を付けて、次が通った
  - `bun test bin/fleet-cli-fixtures.test.ts`(TypeScript の CLI): 98 件(契約の 87 件と、網羅と runner の 11 件)
  - `cargo build --locked -p herdr-fleet-cli` のあと、`HERDR_FLEET_CLI_TARGET=rust:rust/target/debug/fleet bun test bin/fleet-cli-fixtures.test.ts`: 98 件
- workflow のファイルは YAML として読め、3 つの job(`linux`、`ts-corpus`、`fleet-cli`)を持つ(Python の `yaml.safe_load`)
- `cargo build --locked -p herdr-fleet-cli` を空の target のフォルダーで走らせ、手元(16 コア)で 8 秒かかった
- GitHub の runner での結果は、この Issue の pull request の check で確かめる
