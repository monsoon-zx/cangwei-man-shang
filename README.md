# algo · 加密模拟盘 / 模拟盘算法归档（密文）

本分支只放**加密后的源码归档**。没有密钥无法阅读，也无法执行。
明文的算法说明与运行方式见 `crypto/brief` 分支的公开简报（那份是脱敏结果，不含源码）。

## 文件

| 文件 | 说明 |
|---|---|
| `algo/crypto-algo-YYYY-MM-DD.tar.gz.enc` | 某日的加密归档 |
| `algo/manifest.json` | 归档索引：日期、文件数、明文 sha256、key_id |
| `README.md` | 本文件 |

## 加密方式

- 算法：AES-256-GCM（带完整性校验，篡改会直接解密失败）
- 文件格式：`CWA1`（4 字节魔数）+ 12 字节 nonce + 密文与认证标签
- 密钥：32 字节随机数，由维护者离线保管，**不在本仓库任何位置**
- `manifest.json` 里的 `key_id` = 密钥 sha256 的前 8 位，用于区分是哪把密钥加密的

## 解密

在持有密钥的机器上：

```bash
export ALGO_KEY_FILE=~/.config/crypto-algo/algo.key     # 指向密钥文件
python scripts/publish_algo_encrypted.py \
    --decrypt algo/crypto-algo-2026-11-06.tar.gz.enc \
    --out /tmp/crypto-algo
```

解密后会校验明文 sha256 是否与 `manifest.json` 一致，再解开 tar.gz。

## 为什么要这么做

仓库是公开的。把策略源码以明文提交，等于把「11 种打法 + 门控阈值 + 参数」全部公开；
以密文归档则既保留了版本历史和异地备份，又不泄露内容。
`crypto-data` 分支里仍留有 2026-09 之前的早期实验脚本（v2.0~v2.5，已被 v3.4 取代），
那是历史遗留，不影响现行策略。
