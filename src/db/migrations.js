export function runMigrations(db, ensureColumn) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dryrun_trade_metrics (
      position_id INTEGER PRIMARY KEY,
      trade_id INTEGER,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      strategy_id TEXT,
      mode TEXT NOT NULL DEFAULT 'dry_run',
      signal_at_ms INTEGER,
      decision_at_ms INTEGER,
      entry_at_ms INTEGER,
      exit_at_ms INTEGER,
      simulated_latency_seconds REAL DEFAULT 0,
      entry_price_source TEXT,
      entry_mcap REAL,
      exit_mcap REAL,
      highest_mcap REAL,
      lowest_mcap REAL,
      entry_liquidity REAL,
      holders INTEGER,
      top20_holder_percent REAL,
      rug_ratio REAL,
      bundler_rate REAL,
      source_count INTEGER,
      llm_confidence REAL,
      llm_reason TEXT,
      exit_reason TEXT,
      gross_pnl_sol REAL DEFAULT 0,
      net_pnl_sol REAL DEFAULT 0,
      pnl_percent REAL DEFAULT 0,
      max_unrealized_percent REAL DEFAULT 0,
      max_drawdown_percent REAL DEFAULT 0,
      hold_duration_ms INTEGER DEFAULT 0,
      partial_tp_done INTEGER DEFAULT 0,
      entry_failed INTEGER DEFAULT 0,
      exit_failed INTEGER DEFAULT 0,
      notes TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      position_id INTEGER,
      candidate_id INTEGER,
      strategy_id TEXT,
      allowed INTEGER NOT NULL DEFAULT 1,
      reasons_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS performance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exported_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      window_arg TEXT NOT NULL,
      file_path TEXT NOT NULL,
      row_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generated_lessons (
      lesson_id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window TEXT NOT NULL,
      metric TEXT NOT NULL,
      finding TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      confidence_level TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT,
      tool_calls TEXT,
      result_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      pending_action_id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      user_id TEXT,
      chat_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      risk_summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS agent_decision_logs (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      token_mint TEXT,
      token_symbol TEXT,
      position_id INTEGER,
      strategy_id TEXT,
      summary TEXT,
      reason TEXT,
      key_risks TEXT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      rejected_alternatives TEXT,
      user_message TEXT,
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dryrun_metrics_exit ON dryrun_trade_metrics(exit_at_ms, mode);
    CREATE INDEX IF NOT EXISTS idx_dryrun_metrics_strategy ON dryrun_trade_metrics(strategy_id, exit_at_ms);
    CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_exports_created ON exported_reports(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_agent_decisions_time ON agent_decision_logs(timestamp);
  `);

  ensureColumn('chat_messages', 'created_at', 'TEXT');
  ensureColumn('chat_messages', 'tool_calls_json', 'TEXT');
  ensureColumn('chat_messages', 'timestamp', 'INTEGER');
  ensureColumn('user_preferences', 'scope', "TEXT DEFAULT 'global'");
  ensureColumn('pending_actions', 'risk_summary', 'TEXT');
  ensureColumn('agent_decision_logs', 'created_at', 'TEXT');
  ensureColumn('agent_decision_logs', 'timestamp', 'INTEGER');

  ensureColumn('decision_logs', 'actor', 'TEXT');
  ensureColumn('decision_logs', 'summary', 'TEXT');
  ensureColumn('decision_logs', 'key_risks', 'TEXT');
  ensureColumn('decision_logs', 'rejected_alternatives', 'TEXT');
  ensureColumn('decision_logs', 'user_message', 'TEXT');
  ensureColumn('decision_logs', 'tool_calls_json', "TEXT DEFAULT '[]'");
  ensureColumn('decision_logs', 'result', 'TEXT');

  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'simulated_entry_failed', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'simulated_exit_failed', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'net_pnl_sol', 'REAL');
  ensureColumn('dry_run_positions', 'gross_pnl_sol', 'REAL');
  ensureColumn('dry_run_positions', 'max_drawdown_percent', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'max_unrealized_percent', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'lowest_mcap', 'REAL');
  ensureColumn('dry_run_positions', 'current_price', 'REAL');
  ensureColumn('dry_run_positions', 'current_mcap', 'REAL');
  ensureColumn('dry_run_positions', 'opened_at', 'TEXT');
  ensureColumn('dry_run_positions', 'closed_at', 'TEXT');
  ensureColumn('dry_run_positions', 'entry_tx_hash', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_tx_hash', 'TEXT');
  ensureColumn('dry_run_positions', 'remaining_amount', 'REAL');
  ensureColumn('dry_run_positions', 'realized_pnl_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'unrealized_pnl_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'realized_pnl_percent', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'unrealized_pnl_percent', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'is_closed', 'INTEGER DEFAULT 0');

  db.exec(`
    UPDATE dry_run_positions
    SET status = CASE
      WHEN LOWER(status) = 'open' AND partial_tp_done = 1 THEN 'PARTIALLY_CLOSED'
      WHEN LOWER(status) = 'open' THEN 'OPEN'
      WHEN LOWER(status) = 'closed' THEN 'CLOSED'
      WHEN LOWER(status) = 'failed_entry' THEN 'FAILED_ENTRY'
      WHEN LOWER(status) = 'failed_exit' THEN 'FAILED_EXIT'
      WHEN LOWER(status) = 'cancelled' OR LOWER(status) = 'canceled' THEN 'CANCELLED'
      ELSE status
    END;
    UPDATE dry_run_positions
    SET status = CASE
      WHEN closed_at_ms IS NOT NULL AND status IN ('OPEN', 'PARTIALLY_CLOSED') THEN 'CLOSED'
      WHEN exit_reason = 'FAILED_ENTRY' THEN 'FAILED_ENTRY'
      WHEN exit_reason = 'FAILED_EXIT' THEN 'FAILED_EXIT'
      ELSE status
    END;
    UPDATE dry_run_positions
    SET opened_at = COALESCE(opened_at, datetime(opened_at_ms / 1000, 'unixepoch')),
        closed_at = CASE WHEN closed_at_ms IS NOT NULL THEN COALESCE(closed_at, datetime(closed_at_ms / 1000, 'unixepoch')) ELSE closed_at END,
        current_price = COALESCE(current_price, exit_price, entry_price),
        current_mcap = COALESCE(current_mcap, exit_mcap, entry_mcap),
        entry_tx_hash = COALESCE(entry_tx_hash, entry_signature),
        exit_tx_hash = COALESCE(exit_tx_hash, exit_signature),
        remaining_amount = CASE
          WHEN status IN ('CLOSED', 'FAILED_ENTRY', 'CANCELLED') THEN 0
          ELSE COALESCE(remaining_amount, token_amount_est, size_sol, 0)
        END,
        realized_pnl_sol = CASE
          WHEN status = 'CLOSED' AND COALESCE(realized_pnl_sol, 0) = 0 THEN COALESCE(net_pnl_sol, pnl_sol, 0)
          ELSE COALESCE(realized_pnl_sol, 0)
        END,
        realized_pnl_percent = CASE
          WHEN status = 'CLOSED' AND COALESCE(realized_pnl_percent, 0) = 0 THEN COALESCE(pnl_percent, 0)
          ELSE COALESCE(realized_pnl_percent, 0)
        END,
        unrealized_pnl_sol = CASE WHEN status IN ('OPEN', 'PARTIALLY_CLOSED') THEN COALESCE(unrealized_pnl_sol, pnl_sol, 0) ELSE 0 END,
        unrealized_pnl_percent = CASE WHEN status IN ('OPEN', 'PARTIALLY_CLOSED') THEN COALESCE(unrealized_pnl_percent, pnl_percent, 0) ELSE 0 END,
        is_closed = CASE WHEN status IN ('CLOSED', 'FAILED_ENTRY', 'FAILED_EXIT', 'CANCELLED') THEN 1 ELSE 0 END;
    CREATE INDEX IF NOT EXISTS idx_positions_active_status ON dry_run_positions(status, opened_at_ms);
    CREATE INDEX IF NOT EXISTS idx_positions_closed_status ON dry_run_positions(is_closed, closed_at_ms);
  `);
}
