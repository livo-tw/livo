# 自架技術日誌容量控制

此包分三層控制持續增長，不靠磁碟滿了再手動刪檔：

- 所有出廠 Compose 服務的 Docker stdout/stderr 使用 `json-file`，每檔 10 MB、最多 3 檔並壓縮舊檔。這是每容器約 30 MB 的保留界線，單筆超大日誌與輪替過渡可能略超；不是整台主機的總容量上限。新設定須重建相關容器才生效，現存巨大日誌不會因改檔立即縮小。
- Vector 只略過能成功解析、成功 GET/HEAD 的指定健康檢查與 `field_locks` 輪詢，避免高頻技術讀取反覆進 Logflare。寫入、登入、RPC、業務請求、4xx/5xx、錯誤與無法辨識的紀錄仍保留。
- Logflare PostgreSQL 事件資料表另由此處工具每日保留最近 7 天。Docker 輪替不能限制資料庫事件表；BigQuery TTL 也不適用 PostgreSQL。定期刪除搭配一般 VACUUM 回收空間供資料庫重用，**不保證 `df` 已用空間立即下降**。

`selfhost-log-retention.py` 只處理白名單的九種 Supabase 技術來源，從 `_analytics.sources` 即時核對資料表、OID、時間欄位和叢集身分；不修改 LIVO 業務、Slack、來源設定或其他資料表。NULL／未來時間不刪。每次有筆數、時間、WAL 與空間界線，狀態如實區分 disabled/refused/partial/success，不把剩餘過期資料當清完。

Cloudflare 來源 `cloudflare.logs.prod` 的批次先按 `timestamp` 排序，再套用原本的筆數上限與 `FOR UPDATE SKIP LOCKED`；其他八種來源的 SQL 不變。排序不保證每個環境都更快：helper、bind 和安裝程式不建立或保證時間欄位的 B-tree 索引，只有 BRIN 的巨表可能仍須掃描及排序，超過原本 15 秒界線。啟用前應以該實例的索引 metadata 與唯讀 `EXPLAIN` 評估可用的時間欄位 B-tree 和執行成本；新增索引是另外核准的維護工作，本工具不自動執行 DDL。小型無 B-tree fixture 只驗證排序、鎖定與保留邊界，未驗證大型無 B-tree 環境的效能。

## 先準備，再在維護時段啟用

出廠範例 `enabled=false`，安裝與升級程式不會啟用 timer 或刪除事件。容器重建、首次過期清理和既有巨大資料表的實體縮減，都先完成新的快照、完整 DB 與 storage 備份，確認維護時段和足夠空間。既有巨表整理是獨立工作；空間不足時不得執行 VACUUM FULL、TRUNCATE 或刪 `pg_wal`。日常按已核准保留政策執行，不每天再備份一份巨大事件表。

Linux 需 Python 3 標準庫、Docker CLI、systemd，以及對應資料庫容器的既有本機管理權限。不新增網路服務、資料庫角色或 Slack 通知。執行者可使用 Docker 管理權限，故檔案與設定由 root 擁有，不能給一般帳號寫入。

1. 在維護時段將本目錄 helper 安裝至 `/opt/livo-maintenance/bin/selfhost-log-retention.py`（root:root，0750）；範例只供核對預設政策；讓 bind 建立尚不存在的 `/etc/livo/log-retention.json`（0600），狀態目錄 `/var/lib/livo-log-retention` 設 0700。這些路徑位於版本安裝目錄外，升級不能覆寫實例設定。
2. 以 `docker inspect` 核對指定容器的 Compose project/service，使用真實 project、container 名稱建立實例 binding。以下命令的值只是一般範例；不得從名稱猜測目標：

   ```sh
   python3 /opt/livo-maintenance/bin/selfhost-log-retention.py bind --config /etc/livo/log-retention.json --container supabase-db --project supabase --db-user supabase_admin
   python3 /opt/livo-maintenance/bin/selfhost-log-retention.py preview --config /etc/livo/log-retention.json
   ```

   bind 寫入停用的實例 binding，preview 不刪資料。核對結果與備份後，才將該實例 `enabled` 改成 `true`；先手動 `run --config /etc/livo/log-retention.json --apply`，確認結果及業務健康。預設至少 2 GiB 可用空間才准清理，不能拿它搶救已滿的磁碟。
3. 審查並安裝 `.service`、`.timer` 至 `/etc/systemd/system/`；`systemd-analyze verify` 通過後再 `systemctl daemon-reload`，最後才 `systemctl enable --now livo-log-retention.timer`。每日 03:30（主機時區）加 0–15 分鐘錯峰，停機錯過的排程由 Persistent 補跑。未獲時段授權時停在準備。
4. 讀回 `systemctl list-timers livo-log-retention.timer`、`systemctl status livo-log-retention.service`、`journalctl -u livo-log-retention.service` 和外部 `status.json`。監控最後成功時間、expired/backlog、partial/refused、實際容器 log 設定、事件表大小與磁碟趨勢。失敗不得靜默當成功；接到既有監控由實例維護者設定，不自行新增通知對象。

升級或備份前先建立 `/run/livo-maintenance.inhibit` 並等既有 job 結束；完成後才移除自己建立的 inhibit。工具另有單一執行鎖，不能取代升級協調。若容器的 Compose 身分、資料庫叢集、來源或 OID 與核對的身分不符，清理會拒絕；先停止 timer、保存舊設定，使用新的外部設定路徑重新 bind；核對並移交原本的自訂界線後才取代停用中的設定。不盲重試或自動綁到新表。升級後比較新版 helper，於時段內更新穩定 bin，保留外部設定，再跑 preview 和一輪實際驗證。出廠 Compose 上限會隨官方來源升級保留，timer 的穩定路徑不依賴會被替換的安裝目錄。

批次只有在收到並驗證提交 ACK 後，才累計到 `deleted_rows`／`batches` 並清除 `pending_batch`。之後因 WAL、空間、維護 inhibit、時間或筆數界線停止，會回報已知的 `partial`（`result_unknown=false`），下次仍可按原界線繼續；不會宣稱已清完，也不更新最後成功時間。SQL 失敗、回覆逾時／無法解析、ACK 遺失或中斷仍需查核；未解的 `pending_batch`、舊版 unknown 旗標，或 status 同目錄的 `manual-result-unknown.json` 會拒絕 preview／run，保留原 status／marker。先停 timer、保留原證據，針對原 cutoff、來源身分和實際批次結果做唯讀對帳，由維護者在同一實例鎖內明確解除後才繼續；工具不會自動清除或提供強制重跑。

停止排程用 `systemctl disable --now livo-log-retention.timer`，等待 job 結束後設定 `enabled=false`。這不會還原已按保留政策刪除的事件；要還原須使用事先的備份。回復 Vector 過濾時也要預估恢復的寫入量。

## 隔離驗證

在 Git 外副本執行 `python3 scripts/test-docker-log-policy.py`，用真正 Docker Compose render 與 Vector 0.53.0 unit fixtures 檢查輪替和收集規則；`--config-only` 不要求啟動 Docker daemon。`python3 scripts/test-log-retention-postgres.py` 僅建立自有 PostgreSQL 15.8 fixture 容器，以過期／近期／NULL／未來與非目標 sentinel 驗證邊界及拒絕條件，finally 只清理自己的測試容器。不要為驗證而啟動既有正式堆疊。
